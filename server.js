require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createClient } = require('@libsql/client');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(__dirname)); // Servir archivos estáticos (frontend)

// --- CONFIGURACIÓN DE BASE DE DATOS (TURSO) ---
const dbUrl = process.env.TURSO_DATABASE_URL;
const dbToken = process.env.TURSO_AUTH_TOKEN;

// 🛠️ LIMPIEZA DE VARIABLES:
// Eliminamos comillas extra y espacios que pueden causar errores de conexión (Error 400)
const cleanUrl = dbUrl ? dbUrl.replace(/^"|"$/g, '').trim() : null;
const cleanToken = dbToken ? dbToken.replace(/^"|"$/g, '').trim() : null;

// Forzamos libsql:// (WebSockets) porque el driver HTTP (https://) da error de "migration jobs"
const finalDbUrl = cleanUrl?.replace('https://', 'libsql://');

console.log(`🔌 Estado de conexión: URL=${finalDbUrl ? 'Configurada' : 'No definida'}, Token=${cleanToken ? 'Configurado' : 'No definido'}`);

const config = {
    url: finalDbUrl || 'file:local.db',
    intMode: 'number', // Evita errores de BigInt en respuestas JSON
};

if (finalDbUrl && !finalDbUrl.startsWith('file:')) {
    config.authToken = cleanToken;
}

const db = createClient(config);

// Crear tabla si no existe
async function initDB() {
    try {
        await db.execute(`CREATE TABLE IF NOT EXISTS precios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol TEXT,
            nombre TEXT,
            precio REAL,
            var_abs TEXT,
            var_rel TEXT,
            volumen TEXT,
            monto_efectivo REAL,
            hora TEXT,
            icon TEXT,
            fecha_registro DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        console.log("✅ Conexión a base de datos exitosa y tabla verificada.");
    } catch (error) {
        console.error("❌ Error conectando a la base de datos:", error.message);
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

    // 2. INTENTO DE GUARDADO (Base de Datos)
    try {
        // Preparamos las sentencias para inserción por lotes (batch)
        const statements = scrapedData.map(item => ({
            sql: `INSERT INTO precios (symbol, nombre, precio, var_abs, var_rel, volumen, monto_efectivo, hora, icon) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                item.COD_SIMB, item.DESC_SIMB, parseFloat(item.PRECIO), 
                item.VAR_ABS, item.VAR_REL, item.VOLUMEN, 
                parseFloat(item.MONTO_EFECTIVO), item.HORA, item.ICON
            ]
        }));

        if (statements.length > 0) {
            await db.batch(statements, 'write');
            console.log("✅ Datos guardados exitosamente en Turso.");
        }
        
        // Limpieza de datos antiguos (30 días)
        await db.execute("DELETE FROM precios WHERE fecha_registro <= date('now','-30 days')");
    } catch (error) {
        console.error("❌ Error guardando en base de datos (Turso):", error.message);
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
        const result = await db.execute(`SELECT * FROM precios WHERE fecha_registro = (SELECT MAX(fecha_registro) FROM precios)`);
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
        const result = await db.execute({
            sql: `SELECT precio, hora, fecha_registro FROM precios WHERE symbol = ? AND fecha_registro >= date('now', '-' || ? || ' days') ORDER BY fecha_registro ASC`,
            args: [symbol, daysLimit]
        });
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

app.listen(PORT, () => console.log(`Servidor con DB corriendo en http://localhost:${PORT}`));