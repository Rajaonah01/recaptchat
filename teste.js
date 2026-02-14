// Route de test pour vérifier la clé API
app.get('/api/test/cmc', async (req, res) => {
    try {
        const response = await axios.get(`${CMC_API_URL}/cryptocurrency/quotes/latest`, {
            params: {
                id: 1839, // BNB
                convert: 'USD'
            },
            headers: {
                'X-CMC_PRO_API_KEY': CMC_API_KEY
            },
            timeout: 5000
        });

        res.json({
            success: true,
            message: '✅ API CoinMarketCap fonctionne !',
            data: response.data.data[1839].quote.USD.price
        });
    } catch (error) {
        res.json({
            success: false,
            message: '❌ Erreur API',
            error: error.message
        });
    }
});