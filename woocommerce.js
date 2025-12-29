const axios = require('axios');

const apiAxios = axios.create({
  baseURL: 'https://updateavenues.com/wp-json/wc/v3/',
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': 'https://updateavenues.com/',
    'Origin': 'https://updateavenues.com'
  },
  httpsAgent: new (require('https').Agent)({  
    rejectUnauthorized: false
  })
});

// Helper function to add authentication to any request
function addWooAuth(params = {}) {
  return {
    ...params,
    consumer_key: 'ck_26523d9e31115668fbd9e4552c5a44e5f453ad28',
    consumer_secret: 'cs_e70f1004827cd014c9da574f100f6decf4d2e44f'
  };
}

module.exports = { apiAxios, addWooAuth };