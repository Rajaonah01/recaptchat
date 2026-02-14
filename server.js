require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== SÉCURITÉ ==========
app.set('trust proxy', 1);

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'", "https://pro-api.coinmarketcap.com"],
            fontSrc: ["'self'", "https://cdnjs.cloudflare.com"],
        },
    },
}));

app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? [/\.onrender\.com$/, 'https://ton-app.render.com']
        : ['http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true
}));

// ========== COMPRESSION ==========
app.use(compression());

// ========== COOKIES ==========
app.use(cookieParser());

// ========== RATE LIMITING ==========
const limiter = rateLimit({
    windowMs: (parseInt(process.env.RATE_LIMIT_WINDOW) || 15) * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
    message: { 
        success: false, 
        error: '⚠️ Trop de requêtes, veuillez réessayer plus tard.' 
    },
    standardHeaders: true,
    legacyHeaders: false,
    validate: {
        xForwardedForHeader: false,
        trustProxy: false,
        ip: false,
        default: true
    }
});

app.use('/api/', limiter);

// ========== MIDDLEWARE ==========
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ========== LOGGING ==========
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} - IP: ${req.ip || req.socket.remoteAddress}`);
    next();
});

// ========== BASE DE DONNÉES EN MÉMOIRE ==========
const users = new Map();
const transactions = [];

// Configuration des niveaux VIP
const VIP_LEVELS = {
    0: { name: 'VIP 0', minEarned: 0, multiplier: 1.0 },
    1: { name: 'VIP 1', minEarned: 0.001, multiplier: 1.2 },
    2: { name: 'VIP 2', minEarned: 0.005, multiplier: 1.5 },
    3: { name: 'VIP 3', minEarned: 0.01, multiplier: 2.0 }
};

// ========== CONFIGURATION COINMARKETCAP ==========
const CMC_API_KEY = process.env.CMC_API_KEY || ''; // À remplacer par ta clé
const CMC_API_URL = 'https://pro-api.coinmarketcap.com/v1';

// Cache pour les prix (pour éviter de surcharger l'API)
let bnbPrice = 300.00;
let priceHistory = [];
let targetPrice = 300.00;
let lastPriceUpdate = 0;
let bnbData = null;

// Mapping des IDs CoinMarketCap
const COIN_IDS = {
    'BNB': 1839,  // ID de BNB sur CoinMarketCap
    'BTC': 1,
    'ETH': 1027
};

// ========== FONCTION POUR RÉCUPÉRER LES PRIX RÉELS ==========
async function fetchRealPrices() {
    try {
        const response = await axios.get(`${CMC_API_URL}/cryptocurrency/quotes/latest`, {
            params: {
                id: COIN_IDS.BNB,
                convert: 'USD'
            },
            headers: {
                'X-CMC_PRO_API_KEY': CMC_API_KEY
            },
            timeout: 5000
        });

        if (response.data && response.data.data) {
            const bnbRealData = response.data.data[COIN_IDS.BNB];
            bnbPrice = bnbRealData.quote.USD.price;
            targetPrice = bnbPrice;
            
            bnbData = {
                name: bnbRealData.name,
                symbol: bnbRealData.symbol,
                price: bnbPrice,
                volume_24h: bnbRealData.quote.USD.volume_24h,
                percent_change_24h: bnbRealData.quote.USD.percent_change_24h,
                market_cap: bnbRealData.quote.USD.market_cap,
                last_updated: bnbRealData.quote.USD.last_updated
            };
            
            console.log(`✅ Prix BNB réel: $${bnbPrice.toFixed(2)}`);
            
            // Ajouter à l'historique
            priceHistory.push(bnbPrice);
            if (priceHistory.length > 30) priceHistory.shift();
            
            return bnbData;
        }
    } catch (error) {
        console.error('❌ Erreur API CoinMarketCap:', error.message);
        
        // Fallback: prix simulé si l'API échoue
        if (Math.random() < 0.3) {
            targetPrice = 290 + (Math.random() * 20);
        }
        const diff = targetPrice - bnbPrice;
        bnbPrice += diff * 0.1;
        bnbPrice = Math.max(285, Math.min(315, bnbPrice));
        
        priceHistory.push(bnbPrice);
        if (priceHistory.length > 30) priceHistory.shift();
        
        return null;
    }
}

// Appel initial et mise à jour périodique
fetchRealPrices();
setInterval(fetchRealPrices, 60000); // Mise à jour toutes les minutes

// Nettoyage des sessions inactives
setInterval(() => {
    const now = Date.now();
    for (const [userId, userData] of users.entries()) {
        if (now - userData.lastActive > 24 * 60 * 60 * 1000) { // 24h
            users.delete(userId);
        }
    }
}, 60 * 60 * 1000); // 1 heure

// ========== FONCTIONS UTILITAIRES ==========

function generateUserId() {
    return 'user_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now().toString(36);
}

function getUser(req, res) {
    let userId = req.cookies.userId;
    
    if (!userId || !users.has(userId)) {
        userId = generateUserId();
        
        users.set(userId, {
            id: userId,
            balance: 0.00000000,
            totalEarned: 0.00000000,
            vipLevel: 0,
            lastClaim: 0,
            createdAt: Date.now(),
            lastActive: Date.now()
        });
        
        res.cookie('userId', userId, { 
            maxAge: 30 * 24 * 60 * 60 * 1000, // 30 jours
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict'
        });
    }
    
    const user = users.get(userId);
    if (user) {
        user.lastActive = Date.now();
    }
    return user;
}

function calculateVIP(totalEarned) {
    if (totalEarned >= 0.01) return 3;
    if (totalEarned >= 0.005) return 2;
    if (totalEarned >= 0.001) return 1;
    return 0;
}

function getCooldownRemaining(lastClaim) {
    if (!lastClaim) return 0;
    const elapsed = Date.now() - lastClaim;
    const cooldownMs = 60 * 1000; // 60 secondes
    return Math.max(0, Math.ceil((cooldownMs - elapsed) / 1000));
}

// ========== ROUTES API ==========

// Statut du serveur
app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        timestamp: Date.now(),
        uptime: process.uptime(),
        users: users.size,
        transactions: transactions.length,
        env: process.env.NODE_ENV,
        api_source: bnbData ? 'CoinMarketCap Real' : 'Simulation'
    });
});

// Obtenir les infos utilisateur
app.get('/api/user', (req, res) => {
    const user = getUser(req, res);
    
    res.json({
        success: true,
        userId: user.id,
        balance: user.balance.toFixed(8),
        totalEarned: user.totalEarned.toFixed(8),
        vipLevel: calculateVIP(user.totalEarned),
        lastClaim: user.lastClaim,
        cooldown: getCooldownRemaining(user.lastClaim)
    });
});

// Obtenir le prix BNB (avec données réelles CoinMarketCap)
app.get('/api/price', (req, res) => {
    const change = priceHistory.length > 1 
        ? ((priceHistory[priceHistory.length-1] - priceHistory[priceHistory.length-2]) / priceHistory[priceHistory.length-2] * 100).toFixed(2) 
        : 0;
    
    res.json({
        price: bnbPrice.toFixed(2),
        change: change,
        history: priceHistory,
        trend: change >= 0 ? 'up' : 'down',
        real_data: bnbData ? {
            name: bnbData.name,
            symbol: bnbData.symbol,
            volume_24h: bnbData.volume_24h ? `$${Math.round(bnbData.volume_24h).toLocaleString()}` : null,
            percent_change_24h: bnbData.percent_change_24h?.toFixed(2),
            market_cap: bnbData.market_cap ? `$${Math.round(bnbData.market_cap).toLocaleString()}` : null,
            source: 'CoinMarketCap'
        } : null
    });
});

// Claim faucet
app.post('/api/claim', (req, res) => {
    const user = getUser(req, res);
    
    // Vérifier le cooldown
    const cooldown = getCooldownRemaining(user.lastClaim);
    if (cooldown > 0) {
        return res.status(429).json({
            success: false,
            error: 'Cooldown',
            message: `Veuillez attendre ${cooldown} secondes`,
            cooldown: cooldown
        });
    }
    
    // Calculer la récompense en fonction du prix réel
    const vipMultiplier = VIP_LEVELS[calculateVIP(user.totalEarned)].multiplier;
    
    // La récompense varie légèrement avec le prix réel (plus le prix est haut, plus la récompense est petite)
    const priceFactor = 300 / bnbPrice; // Normalisé autour de 300
    const baseReward = (0.000003 + (Math.random() * 0.00002)) * priceFactor;
    const reward = baseReward * vipMultiplier;
    
    // Mettre à jour l'utilisateur
    user.balance += reward;
    user.totalEarned += reward;
    user.lastClaim = Date.now();
    
    // Ajouter aux transactions
    const transaction = {
        id: 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        userId: user.id,
        type: 'claim',
        amount: reward,
        balance: user.balance,
        price_at_claim: bnbPrice,
        timestamp: Date.now()
    };
    transactions.unshift(transaction);
    
    res.json({
        success: true,
        reward: reward.toFixed(8),
        balance: user.balance.toFixed(8),
        totalEarned: user.totalEarned.toFixed(8),
        vipLevel: calculateVIP(user.totalEarned),
        price_at_claim: bnbPrice.toFixed(2),
        timestamp: Date.now()
    });
});

// Withdraw
app.post('/api/withdraw', (req, res) => {
    const { address, amount } = req.body;
    const user = getUser(req, res);
    
    // Validation
    if (!address || address.length < 10) {
        return res.status(400).json({
            success: false,
            error: 'Adresse invalide'
        });
    }
    
    const withdrawAmount = parseFloat(amount);
    if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
        return res.status(400).json({
            success: false,
            error: 'Montant invalide'
        });
    }
    
    if (withdrawAmount > user.balance) {
        return res.status(400).json({
            success: false,
            error: 'Solde insuffisant'
        });
    }
    
    // Simuler le retrait
    user.balance -= withdrawAmount;
    
    // Ajouter aux transactions
    const transaction = {
        id: 'tx_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        userId: user.id,
        type: 'withdraw',
        amount: withdrawAmount,
        address: address,
        balance: user.balance,
        price_at_withdraw: bnbPrice,
        timestamp: Date.now()
    };
    transactions.unshift(transaction);
    
    res.json({
        success: true,
        amount: withdrawAmount.toFixed(8),
        balance: user.balance.toFixed(8),
        value_usd: (withdrawAmount * bnbPrice).toFixed(2),
        message: 'Retrait simulé avec succès',
        txHash: '0x' + Math.random().toString(16).substr(2, 64)
    });
});

// Historique des transactions
app.get('/api/history', (req, res) => {
    const user = getUser(req, res);
    const userTxs = transactions
        .filter(tx => tx.userId === user.id)
        .slice(0, 20)
        .map(tx => ({
            ...tx,
            value_usd: tx.amount * (tx.price_at_claim || tx.price_at_withdraw || bnbPrice)
        }));
    
    res.json({
        success: true,
        count: userTxs.length,
        transactions: userTxs
    });
});

// Obtenir les tendances du marché
app.get('/api/market/trends', async (req, res) => {
    try {
        const response = await axios.get(`${CMC_API_URL}/cryptocurrency/listings/latest`, {
            params: {
                limit: 5,
                convert: 'USD'
            },
            headers: {
                'X-CMC_PRO_API_KEY': CMC_API_KEY
            },
            timeout: 5000
        });

        if (response.data && response.data.data) {
            const trends = response.data.data.map(coin => ({
                name: coin.name,
                symbol: coin.symbol,
                price: coin.quote.USD.price.toFixed(2),
                percent_change_24h: coin.quote.USD.percent_change_24h.toFixed(2),
                market_cap: coin.quote.USD.market_cap
            }));
            
            res.json({
                success: true,
                trends: trends
            });
        } else {
            res.json({
                success: false,
                message: 'Données non disponibles'
            });
        }
    } catch (error) {
        console.error('❌ Erreur tendances:', error.message);
        res.status(500).json({
            success: false,
            error: 'Impossible de récupérer les tendances'
        });
    }
});

// Stats admin
app.get('/api/admin/stats', (req, res) => {
    const { key } = req.query;
    
    if (key !== process.env.ADMIN_KEY) {
        return res.status(401).json({ error: 'Non autorisé' });
    }
    
    const totalBalance = Array.from(users.values()).reduce((sum, u) => sum + u.balance, 0);
    const totalClaimed = Array.from(users.values()).reduce((sum, u) => sum + u.totalEarned, 0);
    
    res.json({
        totalUsers: users.size,
        totalBalance: totalBalance.toFixed(8),
        totalClaimed: totalClaimed.toFixed(8),
        totalValueUSD: (totalBalance * bnbPrice).toFixed(2),
        transactions24h: transactions.filter(tx => Date.now() - tx.timestamp < 86400000).length,
        currentBNBPrice: bnbPrice.toFixed(2),
        apiSource: bnbData ? 'CoinMarketCap Real' : 'Simulation',
        users: Array.from(users.entries()).map(([id, data]) => ({
            id: id.slice(0, 8) + '...',
            balance: data.balance.toFixed(8),
            totalEarned: data.totalEarned.toFixed(8),
            lastActive: new Date(data.lastActive).toISOString()
        }))
    });
});

// Reset user (pour test)
app.post('/api/reset', (req, res) => {
    const user = getUser(req, res);
    user.balance = 0;
    user.totalEarned = 0;
    user.lastClaim = 0;
    
    res.json({
        success: true,
        message: 'Compte réinitialisé'
    });
});

// ========== ROUTE PRINCIPALE ==========
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== GESTION DES ERREURS 404 ==========
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route non trouvée'
    });
});

// ========== GESTION DES ERREURS GLOBALES ==========
app.use((err, req, res, next) => {
    console.error('❌ Erreur serveur:', err);
    res.status(500).json({
        success: false,
        error: 'Erreur interne du serveur',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// ========== DÉMARRAGE ==========
app.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(80));
    console.log('💰 BINANCE FAUCET PRO - API CRYPTO RÉELLE');
    console.log('='.repeat(80));
    console.log(`\n📡 URL: http://localhost:${PORT}`);
    console.log(`🔑 API CoinMarketCap: ${CMC_API_KEY ? 'Configurée' : 'À configurer'}`);
    console.log(`👥 Sessions max: ${Math.floor(process.memoryUsage().heapTotal / 1024 / 1024)} MB`);
    console.log(`🌍 Environnement: ${process.env.NODE_ENV || 'development'}`);
    console.log('\n' + '='.repeat(80) + '\n');
});