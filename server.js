require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(__dirname)); // Servir archivos estáticos (frontend)

// --- CONFIGURACIÓN DE BASE DE DATOS (SUPABASE / POSTGRES) ---
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false // Necesario para conexiones seguras a Supabase/Render
    }
});

// Crear tabla si no existe
async function initDB() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS precios (
            id SERIAL PRIMARY KEY,
            symbol TEXT,
            nombre TEXT,
            precio REAL,
            var_abs TEXT,
            var_rel TEXT,
            volumen TEXT,
            monto_efectivo REAL,
            hora TEXT,
            icon TEXT,
            fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`);
        console.log("✅ Conexión a Supabase (Postgres) exitosa y tabla verificada.");
    } catch (error) {
        console.error("❌ Error conectando a la base de datos:", error.message);
        if (error.code === 'ENOTFOUND') {
            console.error("💡 SUGERENCIA: Es probable que tu proyecto de Supabase esté PAUSADO. Ve a supabase.com y haz clic en 'Restore'.");
        }
    }
}

// Función para obtener y guardar datos
async function fetchAndStore() {
    let scrapedData = [];

    // 1. INTENTO DE DESCARGA (Scraping)
    try {
        console.log("🔄 Conectando a la Bolsa de Valores...");
        const url = 'https://www.bolsadecaracas.com/wp-admin/admin-ajax.php?action=resumenMercadoRentaVariable';
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        scrapedData = response.data;
        console.log(`✅ Datos descargados: ${scrapedData.length} registros encontrados.`);
    } catch (error) {
        console.error("❌ Error descargando datos de la web (Bolsa):", error.message);
        return; // Detenemos aquí si no hay datos para guardar
    }

    // 2. INTENTO DE GUARDADO (Base de Datos Postgres)
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN'); // Iniciar transacción

        const insertQuery = `INSERT INTO precios (symbol, nombre, precio, var_abs, var_rel, volumen, monto_efectivo, hora, icon) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

        for (const item of scrapedData) {
            await client.query(insertQuery, [
                item.COD_SIMB, item.DESC_SIMB, parseFloat(item.PRECIO), 
                item.VAR_ABS, item.VAR_REL, item.VOLUMEN, 
                parseFloat(item.MONTO_EFECTIVO), item.HORA, item.ICON
            ]);
        }
        
        // Limpieza de datos antiguos (30 días) - Sintaxis Postgres
        await client.query("DELETE FROM precios WHERE fecha_registro <= NOW() - INTERVAL '30 days'");
        
        await client.query('COMMIT'); // Confirmar cambios
        console.log("✅ Datos guardados exitosamente en Supabase.");
    } catch (error) {
        if (client) await client.query('ROLLBACK');
        console.error("❌ Error guardando en base de datos:", error.message);
        if (error.code === 'ENOTFOUND') {
            console.error("💡 SUGERENCIA: Es probable que tu proyecto de Supabase esté PAUSADO. Ve a supabase.com y haz clic en 'Restore'.");
        }
    } finally {
        if (client) client.release();
    }
}

// Ejecutar cada 5 minutos (300.000 ms)
initDB().then(() => {
    fetchAndStore(); // Ejecución inicial
    setInterval(fetchAndStore, 300000);
});

// --- RUTAS API ---

// 1. Obtener estado actual (últimos registros)
app.get('/api/bolsa/actual', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM precios WHERE fecha_registro = (SELECT MAX(fecha_registro) FROM precios)`);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

// Obtener historial con rango dinámico
app.get('/api/bolsa/historial/:symbol/:days', async (req, res) => {
    const { symbol, days } = req.params;
    const daysLimit = parseInt(days) || 1;
    
    try {
        // Sintaxis Postgres para parámetros ($1, $2) y fechas
        const result = await pool.query(
            `SELECT precio, hora, fecha_registro FROM precios WHERE symbol = $1 AND fecha_registro >= NOW() - ($2 || ' days')::INTERVAL ORDER BY fecha_registro ASC`,
            [symbol, daysLimit]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));