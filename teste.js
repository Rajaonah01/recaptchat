const axios = require('axios');

const API_KEY = '502ba0b9c146ef23490be75368a0838a';

async function testBalance() {
    try {
        const response = await axios.post('https://api.2captcha.com/getBalance', {
            clientKey: API_KEY
        });
        
        console.log('✅ Connexion réussie !');
        console.log('💰 Ton solde:', response.data.balance, '$');
        
    } catch (error) {
        console.error('❌ Erreur:', error.message);
        console.log('🔑 Vérifie que ta clé API est correcte');
    }
}

testBalance();