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
    consumer_key: 'ck_46c9004d79a72dc4ec58e4306fe2635374643a36',
    consumer_secret: 'cs_c4c8727963b370e9ab6824e7f525b2af47effc3e'
  };
}

module.exports = { apiAxios, addWooAuth };