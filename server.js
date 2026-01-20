require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const { IgApiClient } = require('instagram-private-api');
const { writeFile, readFile } = require('fs').promises;
const { Pool } = require('pg');
const cron = require('node-cron');
const companyMap = require('./company_names'); // Importar diccionario de nombres

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

// --- INTEGRACIÓN CON INSTAGRAM ---
const ig = new IgApiClient();
let igLoggedIn = false;

async function loginToInstagram() {
    if (!process.env.IG_USERNAME || !process.env.IG_PASSWORD) {
        console.log("⚠️  Credenciales de Instagram no encontradas en .env. La publicación en Instagram está deshabilitada.");
        return;
    }
    console.log("🔄 Intentando iniciar sesión en Instagram...");
    ig.state.generateDevice(process.env.IG_USERNAME);

    try {
        // Intentar cargar una sesión guardada
        const sessionFile = 'ig-session.json';
        if (await readFile(sessionFile, 'utf8').catch(() => false)) {
            const session = await readFile(sessionFile, 'utf8');
            await ig.state.deserialize(JSON.parse(session));
            console.log("✅ Sesión de Instagram cargada desde archivo.");
        } else {
            // Si no hay sesión, iniciar con credenciales y guardarla
            await ig.account.login(process.env.IG_USERNAME, process.env.IG_PASSWORD);
            const session = await ig.state.serialize();
            delete session.constants; // Evita conflictos al serializar
            await writeFile(sessionFile, JSON.stringify(session), 'utf8');
            console.log("✅ Inicio de sesión en Instagram exitoso. Sesión guardada.");
        }
        igLoggedIn = true;
    } catch (e) {
        console.error("❌ Error al iniciar sesión en Instagram:", e.message);
    }
}

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
            // Usar el diccionario para interpretar el nombre
            let nombreInterpretado = companyMap[item.DESC_SIMB.trim()];
            
            if (!nombreInterpretado) {
                console.log(`⚠️ [DICCIONARIO] Nombre no encontrado: ${JSON.stringify(item.DESC_SIMB.trim())}. Usando original.`);
                nombreInterpretado = item.DESC_SIMB;
            }

            await client.query(insertQuery, [
                item.COD_SIMB, nombreInterpretado, parseFloat(item.PRECIO), 
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
    loginToInstagram();
    setInterval(fetchAndStore, fetch_time);

    // --- CRON JOB: Publicación Automática ---
    // Lunes a Viernes (1-5) a la 1:00 PM (13:00) Hora Caracas
    cron.schedule('0 13 * * 1-5', async () => {
        console.log("🕐 Ejecutando publicación automática programada...");
        try {
            await publishToInstagram();
            console.log("✅ Publicación automática completada.");
        } catch (error) {
            console.error("❌ Error en publicación automática:", error.message);
        }
    }, { timezone: "America/Caracas" });

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

// Función reutilizable para publicar en Instagram
async function publishToInstagram() {
    if (!igLoggedIn) {
        throw new Error("No se ha iniciado sesión en Instagram. Revisa las credenciales del servidor.");
    }

    // 1. Obtener los datos más recientes del mercado
    const marketResponse = await pool.query(`SELECT * FROM precios WHERE fecha_registro = (SELECT MAX(fecha_registro) FROM precios) ORDER BY var_rel DESC`);
    const marketData = marketResponse.rows;

    if (marketData.length === 0) {
        throw new Error("No hay datos de mercado para publicar.");
    }

    // 2. Procesar datos: Ordenar por Volumen y tomar Top 5
    // Función auxiliar para limpiar formato numérico VE (1.000,00 -> 1000.00)
    const parseVE = (str) => {
        if (!str) return 0;
        // Eliminar puntos de miles y reemplazar coma decimal por punto
        const clean = str.toString().replace(/\./g, '').replace(',', '.');
        return parseFloat(clean) || 0;
    };

    // Ordenar de mayor a menor volumen y tomar los 5 primeros
    const topVolumen = marketData
        .sort((a, b) => parseVE(b.volumen) - parseVE(a.volumen))
        .slice(0, 5);

    const lastUpdate = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas' });
    
    let caption = `Top 5 Acciones con más volumen del día\n
    📊 Bolsa de Valores de Caracas\n\n`;
    caption += `🗓️ ${lastUpdate}\n\n`;
    
    for (const [i, stock] of topVolumen.entries()) {
        const icon = parseFloat(stock.var_abs) >= 0 ? '🟢' : '🔴';
        caption += `${i + 1}. ${stock.symbol}: ${parseFloat(stock.precio).toLocaleString('es-VE')} VES (${icon} ${stock.var_rel}%)\n`;
    }

    caption += `\n#Bolsadecaracas #dinero #acciones #graficas #graficos #bolsa #valor #valores #caracas #envivo #MercadoDeValores #Venezuela #venezuela #venezolanos #Finanzas\n`;
    caption += `Información con fines educativos.`;

    // 3. Generar imagen con Canvas (Diseño tipo "Canva")
    console.log("🖼️  Generando imagen personalizada...");
    const width = 1080;
    const height = 1080;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    // -- FONDO --
    ctx.fillStyle = '#0f172a'; // Color de fondo oscuro (igual a tu app)
    ctx.fillRect(0, 0, width, height);

    // -- TÍTULO --
    ctx.fillStyle = '#38bdf8'; // Azul claro
    ctx.font = 'bold 60px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Top 5 acciones del día', width / 2, 140);
    
    ctx.fillStyle = '#94a3b8'; // Gris claro
    ctx.font = '30px sans-serif';
    ctx.fillText('Volumen de transacciones', width / 2, 200);

    // -- LISTA DE ACCIONES --
    const startY = 320;
    const rowHeight = 130;

    for (const [i, stock] of topVolumen.entries()) {
        const y = startY + (i * rowHeight);
        const isUp = parseFloat(stock.var_abs) >= 0;
        const color = isUp ? '#22c55e' : '#e70000'; // Verde o Rojo
        const arrow = isUp ? '▲' : '▼';

        // Fondo de la fila (tarjeta)
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(50, y - 80, 980, 110);

        // Rank (1., 2., etc)
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 45px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`${i + 1}.`, 70, y);

        // Logo
        try {
            if (stock.icon) {
                const logo = await loadImage(stock.icon);
                // Centrar logo verticalmente (60x60)
                ctx.drawImage(logo, 120, y - 55, 60, 60);
            }
        } catch (e) {
            console.log(`No se pudo cargar logo para ${stock.symbol}`);
        }

        // Símbolo y Nombre
        const textStartX = 200;
        ctx.fillText(stock.symbol, textStartX, y);
        
        const symbolWidth = ctx.measureText(stock.symbol).width;
        ctx.fillStyle = '#94a3b8'; // Gris claro para el nombre
        ctx.font = '30px sans-serif';
        ctx.fillText(stock.nombre, textStartX + symbolWidth + 15, y);

        // Precio (Derecha Arriba)
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 40px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(`${parseFloat(stock.precio).toLocaleString('es-VE')} VES`, 980, y - 10);

        // Variación (Derecha Abajo)
        ctx.font = '30px sans-serif';
        ctx.fillStyle = color;
        ctx.fillText(`${arrow} ${stock.var_rel}%`, 980, y + 25);
    }

    // -- FOOTER --
    ctx.fillStyle = '#64748b';
    ctx.font = '25px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Visita www.bolsa-de-valores.onrender.com para ver gráficos en tiempo real.', width / 2, 1040);

    const imageBuffer = canvas.toBuffer('image/jpeg');

    // 4. Publicar en Instagram
    console.log(`🚀 Publicando Top 5 en Instagram...`);
    await ig.publish.photo({
        file: imageBuffer,
        caption: caption,
    });
    
    return { success: true };
}

// Endpoint para publicar un resumen en Instagram (Manual)
app.get('/api/instagram/post-summary', async (req, res) => {
    try {
        await publishToInstagram();
        res.json({ success: true, message: `Top 5 publicado en Instagram exitosamente.` });
    } catch (error) {
        console.error("❌ Error al publicar en Instagram:", error.message);
        res.status(500).json({ error: "Error interno del servidor al intentar publicar.", details: error.message });
    }
});

// 1. Obtener estado actual (últimos registros)
app.get('/api/bolsa/actual', async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM precios WHERE fecha_registro = (SELECT MAX(fecha_registro) FROM precios)`);
        const rows = result.rows.map(row => {
            const mapped = companyMap[row.nombre.trim()];
            if (mapped) row.nombre = mapped;
            return row;
        });
        res.json(rows);
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

// Obtener historial con rango dinámico
app.get('/api/bolsa/historial/:symbol/:days', async (req, res) => {
    const { symbol, days } = req.params;
    const daysLimit = parseInt(days) || 1;
    
    try {
        let result;
        if (daysLimit === 1) {
            // Rango 1 día: Mostrar todos los puntos (Intradía)
            result = await pool.query(
                `SELECT precio, hora, fecha_registro FROM precios WHERE symbol = $1 AND fecha_registro >= NOW() - INTERVAL '1 day' ORDER BY fecha_registro ASC`,
                [symbol]
            );
        } else {
            // Rango > 1 día: Mostrar solo 1 punto por día (El último registro/cierre de cada día)
            result = await pool.query(
                `SELECT * FROM (
                    SELECT DISTINCT ON (DATE(fecha_registro))
                        precio, hora, fecha_registro
                    FROM precios
                    WHERE symbol = $1 AND fecha_registro >= NOW() - ($2 || ' days')::INTERVAL
                    ORDER BY DATE(fecha_registro) ASC, fecha_registro DESC
                ) sub ORDER BY fecha_registro ASC`,
                [symbol, daysLimit]
            );
        }
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

app.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));