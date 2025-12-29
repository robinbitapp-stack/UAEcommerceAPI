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
    consumer_key: 'ck_b43e50e28e367660064b96ca7b43e17f651b2832',
    consumer_secret: 'cs_c5728578585c230138d174d8fdf91b502af0087c'
  };
}

module.exports = { apiAxios, addWooAuth };