require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== MIDDLEWARE ==========
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Rate limiting - Anti abus
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // 100 requêtes par IP
});
app.use('/api/', limiter);

// ========== CONFIGURATION 2CAPTCHA ==========
const CONFIG = {
    API_KEY: process.env.CAPTCHA_API_KEY,
    API_URL: 'https://api.2captcha.com',
    POLL_INTERVAL: 5000,
    SOFT_ID: 0
};

// ========== STATISTIQUES DE GAINS ==========
let earnings = {
    today: {
        captchas: 0,
        amount: 0
    },
    yesterday: {
        captchas: 0,
        amount: 0
    },
    thisWeek: {
        captchas: 0,
        amount: 0
    },
    thisMonth: {
        captchas: 0,
        amount: 0
    },
    total: {
        captchas: 0,
        amount: 0
    },
    lastUpdate: Date.now()
};

// Historique des paiements
let paymentHistory = [];

// ========== FONCTIONS 2CAPTCHA ==========

// 1️⃣ Vérifier le solde du compte
async function getBalance() {
    try {
        const response = await axios.post(`${CONFIG.API_URL}/getBalance`, {
            clientKey: CONFIG.API_KEY
        });
        
        if (response.data.error) {
            console.error('❌ Erreur solde:', response.data.error);
            return 0;
        }
        
        return parseFloat(response.data.balance) || 0;
    } catch (error) {
        console.error('❌ Erreur API balance:', error.message);
        return 0;
    }
}

// 2️⃣ Envoyer un captcha à résoudre
async function createCaptchaTask(siteKey, pageUrl) {
    try {
        const response = await axios.post(`${CONFIG.API_URL}/createTask`, {
            clientKey: CONFIG.API_KEY,
            task: {
                type: 'NoCaptchaTaskProxyless',
                websiteURL: pageUrl,
                websiteKey: siteKey
            },
            softId: CONFIG.SOFT_ID
        });

        if (response.data.error) {
            console.error('❌ Erreur création:', response.data.error);
            return null;
        }

        return response.data.taskId;
    } catch (error) {
        console.error('❌ Erreur API createTask:', error.message);
        return null;
    }
}

// 3️⃣ Récupérer le résultat du captcha
async function getTaskResult(taskId) {
    try {
        const response = await axios.post(`${CONFIG.API_URL}/getTaskResult`, {
            clientKey: CONFIG.API_KEY,
            taskId: taskId
        });

        if (response.data.error) {
            return { status: 'error', error: response.data.error };
        }

        if (response.data.status === 'ready') {
            return { 
                status: 'ready', 
                solution: response.data.solution.gRecaptchaResponse 
            };
        }

        return { status: 'processing' };
    } catch (error) {
        console.error('❌ Erreur récupération:', error.message);
        return { status: 'error', error: error.message };
    }
}

// 4️⃣ Ajouter des gains
function addEarnings(captchaCount = 1) {
    // Tarif: 0.5$ pour 1000 captchas = 0.0005$ par captcha
    const RATE_PER_CAPTCHA = 0.0005;
    const amount = captchaCount * RATE_PER_CAPTCHA;
    
    const now = new Date();
    const today = now.toDateString();
    const week = getWeekNumber(now);
    const month = now.getMonth();
    
    // Mise à jour des stats
    earnings.today.captchas += captchaCount;
    earnings.today.amount += amount;
    
    earnings.thisWeek.captchas += captchaCount;
    earnings.thisWeek.amount += amount;
    
    earnings.thisMonth.captchas += captchaCount;
    earnings.thisMonth.amount += amount;
    
    earnings.total.captchas += captchaCount;
    earnings.total.amount += amount;
    
    earnings.lastUpdate = Date.now();
    
    console.log(`💰 GAGNÉ: ${amount.toFixed(4)}$ (${captchaCount} captcha${captchaCount > 1 ? 's' : ''})`);
    console.log(`📊 Total aujourd'hui: ${earnings.today.amount.toFixed(4)}$`);
    
    return amount;
}

// Utilitaire: numéro de semaine
function getWeekNumber(d) {
    d = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

// Reset quotidien (à minuit)
cron.schedule('0 0 * * *', () => {
    earnings.yesterday = { ...earnings.today };
    earnings.today = { captchas: 0, amount: 0 };
    console.log('📅 Stats quotidiennes réinitialisées');
});

// ========== ROUTES API ==========

// 1️⃣ PAGE PRINCIPALE - Les visiteurs résolvent des captchas
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2️⃣ DASHBOARD - Pour voir tes gains
app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// 3️⃣ API: Soumettre un captcha (APPELÉ PAR TES VISITEURS)
app.post('/api/captcha/submit', async (req, res) => {
    const { token, siteKey, pageUrl } = req.body;
    
    if (!token) {
        return res.status(400).json({ success: false, error: 'Token manquant' });
    }
    
    try {
        // Créer la tâche sur 2captcha
        const taskId = await createCaptchaTask(
            siteKey || '6LfJ7bIUAAAAAHqUy2jB3TqYJpLhXqHqZqHqZ',
            pageUrl || req.headers.referer || 'https://ton-site.com'
        );
        
        if (!taskId) {
            return res.json({ success: false, error: 'Erreur création tâche' });
        }
        
        // Attendre le résultat
        let result = { status: 'processing' };
        let attempts = 0;
        
        while (result.status === 'processing' && attempts < 30) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            result = await getTaskResult(taskId);
            attempts++;
        }
        
        if (result.status === 'ready') {
            // ✅ TU GAGNES DE L'ARGENT !
            addEarnings(1);
            
            res.json({
                success: true,
                solution: result.solution
            });
        } else {
            res.json({
                success: false,
                error: 'Timeout ou erreur'
            });
        }
        
    } catch (error) {
        console.error('❌ Erreur soumission:', error);
        res.status(500).json({ success: false, error: 'Erreur serveur' });
    }
});

// 4️⃣ API: Obtenir les stats (protégé par mot de passe)
app.post('/api/admin/stats', async (req, res) => {
    const { password } = req.body;
    
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Non autorisé' });
    }
    
    const balance = await getBalance();
    
    res.json({
        earnings,
        balance: balance.toFixed(4),
        paymentHistory,
        server: {
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            timestamp: Date.now()
        }
    });
});

// 5️⃣ API: Effectuer un retrait
app.post('/api/admin/withdraw', async (req, res) => {
    const { password, amount, address } = req.body;
    
    if (password !== process.env.ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Non autorisé' });
    }
    
    // Simulation de retrait (dans la vraie vie, API 2captcha withdraw)
    const withdrawal = {
        id: `WITHDRAW_${Date.now()}`,
        amount: parseFloat(amount),
        address: address,
        timestamp: Date.now(),
        status: 'pending'
    };
    
    paymentHistory.push(withdrawal);
    
    res.json({
        success: true,
        withdrawal
    });
});

// ========== DÉMARRAGE ==========
app.listen(PORT, '0.0.0.0', async () => {
    console.log('\n' + '='.repeat(70));
    console.log('💰💰💰 FERME DE CAPTCHA - MODE GAINS 💰💰💰');
    console.log('='.repeat(70));
    console.log(`📡 URL: http://localhost:${PORT}`);
    console.log(`🔑 API Key: ${CONFIG.API_KEY.slice(0,8)}...`);
    
    const balance = await getBalance();
    console.log(`💰 Solde 2captcha: ${balance.toFixed(4)}$`);
    
    console.log('\n📊 TARIF: 0.0005$ PAR CAPTCHA');
    console.log('🎯 1000 captchas = 0.50$ POUR TOI !');
    console.log('='.repeat(70) + '\n');
});