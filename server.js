require('dotenv').config();
const express = require('express');
const http = require('http'); // Importar http
const { WebSocketServer } = require('ws'); // Importar WebSocket
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

// --- CONFIGURACIÓN DEL SERVIDOR HTTP Y WEBSOCKETS ---
const server = http.createServer(app); // Crear servidor HTTP desde Express
const wss = new WebSocketServer({ server }); // Adjuntar WebSocket server al servidor HTTP

wss.on('connection', ws => {
    console.log('🔌 Nuevo cliente conectado vía WebSocket.');
    ws.on('close', () => {
        console.log('🔌 Cliente desconectado.');
    });
});

function broadcast(data) {
    const jsonData = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === client.OPEN) {
            client.send(jsonData);
        }
    });
}

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

        if (day === 0 || day === 6 || hour < 9 || (hour > 13 || (hour === 13 && caracasTime.getMinutes() >= 10))) {
            console.log(`💤 Mercado cerrado (Caracas: ${caracasTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true })}). No se actualizarán datos.`);
            return;
        }
    }

    let scrapedData = [];

    // 1. INTENTO DE DESCARGA (Scraping)
    try {
        console.log("🔄 Conectando a la Bolsa de Valores...");
        const url = 'https://www.bolsadecaracas.com/wp-admin/admin-ajax.php?action=resumenMercadoRentaVariable';
        const response = await axios.get(url, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Referer': 'https://www.bolsadecaracas.com/',
                'X-Requested-With': 'XMLHttpRequest',
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'Origin': 'https://www.bolsadecaracas.com',
                'Host': 'www.bolsadecaracas.com'
            }
        });
        scrapedData = response.data;
        console.log(`✅ Datos descargados: ${scrapedData.length} registros encontrados.`);
    } catch (error) {
        console.warn(`⚠️ No se pudieron obtener nuevos datos de la Bolsa (${error.message}).`);
        console.log("ℹ️ La aplicación continuará funcionando con los datos existentes en la base de datos.");
        return; // Mantenemos los datos actuales en DB sin cambios
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

        // Después de guardar, notificar a los clientes vía WebSocket
        const latestData = await getLatestMarketData();
        if (latestData) {
            broadcast(latestData);
        }
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
            console.log("✅ Publicación automática de Top 5 completada.");

            // Esperar un poco para no saturar la API de Instagram
            await new Promise(resolve => setTimeout(resolve, 30000)); // 30 segundos

            await publishAllStocksToInstagram();
            console.log("✅ Publicación automática de resumen completo completada.");
        } catch (error) {
            console.error("❌ Error en publicación automática:", error.message);
        }
    }, { timezone: "America/Caracas" });

    // --- KEEP ALIVE PARA RENDER ---
    // Evita que el servidor se duerma haciendo una petición a sí mismo cada 14 min
    const APP_URL = process.env.RENDER_EXTERNAL_URL; 
    if (APP_URL) {
        console.log(`⏰ Keep-Alive activado apuntando a: ${APP_URL}`);
        setInterval(() => {
            axios.get(`${APP_URL}/api/update-manual`).catch(() => {});
        }, 800000); // 14 minutos (Render duerme a los 15)
    }
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

async function generateStockImage(stocks, title, subtitle, pageInfo = null) {
    const width = 1080;
    const height = 1080;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const roundRect = (ctx, x, y, width, height, radius) => {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    };

    const gradient = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, width / 1.5);
    gradient.addColorStop(0, '#1e3a8a');
    gradient.addColorStop(1, '#0f172a');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 72px sans-serif';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    // ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 5;
    ctx.fillText(title, width / 2, 150);
    ctx.shadowColor = 'transparent';

    ctx.fillStyle = '#93c5fd';
    ctx.font = '35px sans-serif';
    ctx.fillText(subtitle, width / 2, 210);

    const startY = 280;
    const rowHeight = 135;
    const cardWidth = 980;
    const cardHeight = 110;
    const cardX = (width - cardWidth) / 2;

    for (const [i, stock] of stocks.entries()) {
        const y = startY + (i * rowHeight);
        const isUp = parseFloat(String(stock.var_abs).replace(',', '.')) >= 0;
        const color = isUp ? '#22c55e' : '#ef4444';
        const arrow = isUp ? '▲' : '▼';

        ctx.fillStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
        ctx.lineWidth = 1;
        roundRect(ctx, cardX, y, cardWidth, cardHeight, 20);
        ctx.fill();
        ctx.stroke();

        const contentY = y + cardHeight / 2;

        const logoX = cardX + 30;
        const logoY = y + 25;
        const logoSize = 60;
        try {
            if (stock.icon) {
                const logo = await loadImage(stock.icon);
                ctx.save();
                ctx.beginPath();
                ctx.arc(logoX + logoSize / 2, logoY + logoSize / 2, logoSize / 2, 0, Math.PI * 2, true);
                ctx.closePath();
                ctx.clip();
                ctx.drawImage(logo, logoX, logoY, logoSize, logoSize);
                ctx.restore();
            }
        } catch (e) {
            console.log(`No se pudo cargar logo para ${stock.symbol}`);
        }

        const textStartX = logoX + logoSize + 30;
        ctx.textAlign = 'left';
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 40px sans-serif';
        ctx.fillText(stock.symbol, textStartX, contentY + 10);
        const symbolWidth = ctx.measureText(stock.symbol).width;
        
        ctx.fillStyle = '#94a3b8';
        ctx.font = '24px sans-serif';
        ctx.fillText(stock.nombre, textStartX + symbolWidth + 15, contentY + 8);

        ctx.textAlign = 'right';
        // ctx.shadowColor = transparent';
        // ctx.shadowBlur = 15;

        ctx.fillStyle = color;
        ctx.font = 'bold 42px sans-serif';
        ctx.fillText(`${parseFloat(stock.precio).toLocaleString('es-VE')} Bs.`, cardX + cardWidth - 30, contentY - 5);

        ctx.font = 'bold 28px sans-serif';
        ctx.fillText(`${arrow} ${stock.var_rel}%`, cardX + cardWidth - 30, contentY + 35);
        
        ctx.shadowColor = 'transparent';
    }

    ctx.textAlign = 'center';
    ctx.fillStyle = '#64748b';
    ctx.font = '22px sans-serif';
    ctx.fillText('www.bolsa-de-valores.onrender.com', width / 2, height - 50);

    if (pageInfo) {
        ctx.font = 'bold 18px sans-serif';
        ctx.fillText(`Página ${pageInfo.current} de ${pageInfo.total}`, width / 2, height - 25);
    } else {
        ctx.font = '18px sans-serif';
        ctx.fillText('Información con fines educativos.', width / 2, height - 25);
    }

    return canvas.toBuffer('image/jpeg');
}

// Función reutilizable para publicar en Instagram
async function publishToInstagram() {
    if (!igLoggedIn) {
        throw new Error("No se ha iniciado sesión en Instagram. Revisa las credenciales del servidor.");
    }

    // 1. Obtener los datos más recientes del mercado
    const marketData = await getLatestMarketData();

    if (marketData.length === 0) {
        throw new Error("No hay datos de mercado para publicar.");
    }

    // 2. Procesar datos: Ordenar por Volumen y tomar Top 5
    const parseVE = (str) => {
        if (!str) return 0;
        const clean = str.toString().replace(/\./g, '').replace(',', '.');
        return parseFloat(clean) || 0;
    };

    const topVolumen = marketData
        .sort((a, b) => parseVE(b.volumen) - parseVE(a.volumen))
        .slice(0, 5);

    // 3. Generar caption
    const lastUpdate = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas', hour12: true });
    let caption = `Top 5 Acciones con más operaciones del día\n
    📊 Bolsa de Valores de Caracas\n\n`;
    caption += `🗓️ ${lastUpdate}\n
    Volumen de transacciones:\n\n`;
    
    for (const [i, stock] of topVolumen.entries()) {
        caption += `${i + 1}. ${stock.symbol}: ${parseFloat(stock.volumen).toLocaleString('es-VE')} Bs.\n`;
    }

    caption += `\n#Bolsadecaracas #dinero #acciones #graficas #graficos #bolsa #valor #valores #caracas #envivo #MercadoDeValores #Venezuela #venezuela #venezolanos #Finanzas\n`;
    caption += `Información con fines educativos.`;

    // 4. Generar imagen
    console.log("🖼️  Generando imagen para Top 5...");
    const imageBuffer = await generateStockImage(topVolumen, 'Top 5 Acciones', 'Más tranzadas del día');

    // 5. Publicar en Instagram
    console.log(`🚀 Publicando Top 5 en Instagram...`);
    await ig.publish.photo({
        file: imageBuffer,
        caption: caption,
    });
    
    return { success: true };
}

async function publishAllStocksToInstagram() {
    if (!igLoggedIn) {
        throw new Error("No se ha iniciado sesión en Instagram. Revisa las credenciales del servidor.");
    }

    // 1. Get all latest stocks, sorted alphabetically
    const allStocks = await getLatestMarketData();
    allStocks.sort((a, b) => a.symbol.localeCompare(b.symbol));

    if (allStocks.length === 0) {
        throw new Error("No hay datos de mercado para publicar el resumen completo.");
    }

    // 2. Chunk stocks into groups of 5
    const chunkSize = 5;
    const stockChunks = [];
    for (let i = 0; i < allStocks.length; i += chunkSize) {
        stockChunks.push(allStocks.slice(i, i + chunkSize));
    }

    // 3. Generate an image for each chunk
    const imageItems = [];
    const totalPages = stockChunks.length;
    console.log(`🖼️  Generando carrusel de ${totalPages} imágenes...`);

    for (const [i, chunk] of stockChunks.entries()) {
        const pageInfo = { current: i + 1, total: totalPages };
        const imageBuffer = await generateStockImage(
            chunk,
            'Resumen del Mercado',
            'Cierre del Día',
            pageInfo
        );
        imageItems.push({ file: imageBuffer });
    }

    // 4. Create caption and publish album
    const lastUpdate = new Date().toLocaleString('es-VE', { timeZone: 'America/Caracas', hour12: true });
    let caption = `Resumen completo del mercado al cierre del día.\n
    📊 Bolsa de Valores de Caracas\n
    🗓️ ${lastUpdate}\n\n`;
    caption += `Desliza para ver todas las acciones. 👉\n\n`;
    caption += `#Bolsadecaracas #dinero #acciones #bolsa #valor #valores #caracas #MercadoDeValores #Venezuela #Finanzas\n`;
    caption += `Información con fines educativos.`;

    if (imageItems.length > 1) {
        console.log(`🚀 Publicando carrusel de ${imageItems.length} imágenes en Instagram...`);
        await ig.publish.album({
            items: imageItems,
            caption: caption,
        });
    } else if (imageItems.length === 1) {
        console.log(`🚀 Publicando resumen (1 imagen) en Instagram...`);
        await ig.publish.photo({
            file: imageItems[0].file,
            caption: caption,
        });
    } else {
        console.log("ℹ️ No se generaron imágenes para el resumen completo.");
        return { success: false, message: "No images generated." };
    }

    return { success: true, pages: imageItems.length };
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

app.get('/api/instagram/post-all-summary', async (req, res) => {
    try {
        const result = await publishAllStocksToInstagram();
        res.json({ success: true, message: `Resumen completo (${result.pages} páginas) publicado en Instagram exitosamente.` });
    } catch (error) {
        console.error("❌ Error al publicar el resumen completo en Instagram:", error.message);
        res.status(500).json({ error: "Error interno del servidor al intentar publicar.", details: error.message });
    }
});

// Función para obtener los últimos datos del mercado (reutilizable)
async function getLatestMarketData() {
    const result = await pool.query(`SELECT * FROM (
        SELECT DISTINCT ON (symbol) * 
        FROM precios 
        ORDER BY symbol, fecha_registro DESC
    ) sub ORDER BY fecha_registro DESC`);
    const rows = result.rows.map(row => {
        const mapped = companyMap[row.nombre.trim()];
        if (mapped) row.nombre = mapped;
        return row;
    });
    return rows;
}

// 1. Obtener estado actual (últimos registros)
app.get('/api/bolsa/actual', async (req, res) => {
    try {
        // Esta ruta ahora solo se usa para la carga inicial de la página.
        const rows = await getLatestMarketData();
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
        // Obtener TODOS los registros dentro del rango (sin filtrar 1 por día)
        const result = await pool.query(
            `SELECT precio, hora, fecha_registro FROM precios WHERE symbol = $1 AND fecha_registro >= NOW() - ($2 || ' days')::INTERVAL ORDER BY fecha_registro ASC`,
            [symbol, daysLimit]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({error: err.message});
    }
});

server.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));