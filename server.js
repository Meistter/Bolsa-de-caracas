require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const fetch_time = parseInt(process.env.UPDATE_INTERVAL) || 600000;
const cleanup_days = parseInt(process.env.DB_CLEANUP_DAYS) || 30;
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
async function fetchAndStore(force = false) {
    if (!force) {
        const now = new Date();
        // Convertimos a hora de Caracas para verificar horario (Lunes-Viernes, 9am-1pm)
        const caracasTime = new Date(now.toLocaleString("en-US", { timeZone: "America/Caracas" }));
        const day = caracasTime.getDay(); // 0 = Domingo, 6 = Sábado
        const hour = caracasTime.getHours();

        if (day === 0 || day === 6 || hour < 9 || hour >= 13) {
            console.log(`💤 Mercado cerrado (Caracas: ${caracasTime.toLocaleTimeString()}). No se actualizarán datos.`);
            return;
        }
    }

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
        
        // Limpieza de datos antiguos (Configurable vía variable de entorno)
        await client.query(`DELETE FROM precios WHERE fecha_registro <= NOW() - INTERVAL '${cleanup_days} days'`);
        
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
    setInterval(fetchAndStore, fetch_time);

    // --- KEEP ALIVE PARA RENDER ---
    // Evita que el servidor se duerma haciendo una petición a sí mismo cada 14 min
    // const APP_URL = process.env.RENDER_EXTERNAL_URL; 
    // if (APP_URL) {
    //     console.log(`⏰ Keep-Alive activado apuntando a: ${APP_URL}`);
    //     setInterval(() => {
    //         axios.get(`${APP_URL}/api/update-manual`).catch(() => {});
    //     }, 840000); // 14 minutos (Render duerme a los 15)
    // }
});

// --- RUTAS API ---

// Endpoint para compartir configuración con el frontend
app.get('/api/config', (req, res) => {
    res.json({ updateInterval: fetch_time });
});

// Endpoint para mantener la app viva (Keep-Alive)
app.get('/api/update-manual', (req, res) => {
    res.send('App activa (Keep-Alive).');
});

// Endpoint para forzar actualización de datos (incluso fuera de horario)
app.get('/api/fetch-data', async (req, res) => {
    await fetchAndStore(true);
    res.send('Actualización manual ejecutada.');
});

// // Endpoint para limpiar toda la base de datos manualmente
// app.get('/api/clear-data', async (req, res) => {
//     try {
//         await pool.query('TRUNCATE TABLE precios');
//         res.send('✅ Base de datos limpiada completamente.');
//     } catch (error) {
//         res.status(500).send('❌ Error al limpiar la base de datos: ' + error.message);
//     }
// });

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