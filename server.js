const express = require('express');
const axios = require('axios');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = 3000;

app.use(cors());

// --- CONFIGURACIÓN DE BASE DE DATOS ---
const db = new sqlite3.Database('./bolsa_historial.db');

// Crear tabla si no existe
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS precios (
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
});

// Función para obtener y guardar datos
async function fetchAndStore() {
    try {
        const url = 'https://www.bolsadecaracas.com/wp-admin/admin-ajax.php?action=resumenMercadoRentaVariable';
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        
        const data = response.data;
        const stmt = db.prepare(`INSERT INTO precios (symbol, nombre, precio, var_abs, var_rel, volumen, monto_efectivo, hora, icon) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

        data.forEach(item => {
            stmt.run(
                item.COD_SIMB, item.DESC_SIMB, parseFloat(item.PRECIO), 
                item.VAR_ABS, item.VAR_REL, item.VOLUMEN, 
                parseFloat(item.MONTO_EFECTIVO), item.HORA, item.ICON
            );
        });
        stmt.finalize();
        
       // Cambia '-7 days' por '-30 days' en la función fetchAndStore
db.run("DELETE FROM precios WHERE fecha_registro <= date('now','-30 days')");
        
        console.log(`[${new Date().toLocaleTimeString()}] Datos guardados y limpieza de 7 días ejecutada.`);
    } catch (error) {
        console.error("Error obteniendo datos:", error.message);
    }
}

// Ejecutar cada 5 minutos (300.000 ms)
setInterval(fetchAndStore, 300000);
fetchAndStore(); // Ejecución inicial

// --- RUTAS API ---

// 1. Obtener estado actual (últimos registros)
app.get('/api/bolsa/actual', (req, res) => {
    db.all(`SELECT * FROM precios WHERE fecha_registro = (SELECT MAX(fecha_registro) FROM precios)`, [], (err, rows) => {
        if (err) return res.status(500).json({error: err.message});
        res.json(rows);
    });
});

// Obtener historial con rango dinámico
app.get('/api/bolsa/historial/:symbol/:days', (req, res) => {
    const { symbol, days } = req.params;
    const daysLimit = parseInt(days) || 1;
    
    db.all(`
        SELECT precio, hora, fecha_registro 
        FROM precios 
        WHERE symbol = ? 
        AND fecha_registro >= date('now', '-' || ? || ' days')
        ORDER BY fecha_registro ASC
    `, [symbol, daysLimit], (err, rows) => {
        if (err) return res.status(500).json({error: err.message});
        res.json(rows);
    });
});

app.listen(PORT, () => console.log(`Servidor con DB corriendo en http://localhost:${PORT}`));