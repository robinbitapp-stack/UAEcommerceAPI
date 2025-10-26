const express = require('express');
const WooCommerceRestApi = require("@woocommerce/woocommerce-rest-api").default;
const app = express();
const PORT = process.env.PORT || 3000;
const cheerio = require('cheerio');
const FORCE_NGN_CURRENCY = '&currency=NGN';
require('dotenv').config();

//API
const consumerKeyWC = 'ck_bb500a1fb70b1094d43fd85296ad10c5dada160b';
const consumerSercretWC = 'cs_b7232701e74d5e22fe79c70b312e36acb4d8757a';

const api = new WooCommerceRestApi({
  url: 'https://updateavenues.com', 
  consumerKey: consumerKeyWC,
  consumerSecret: consumerSercretWC,
  version: 'wc/v3',
  queryStringAuth: true
});

const apiAxios = require('./woocommerce'); 

// Redis setup
const Redis = require('ioredis');
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true
});

// Redis connection events
redis.on('connect', () => console.log('✅ Redis connected'));
redis.on('error', (err) => console.error('❌ Redis error:', err));
redis.on('ready', () => console.log('🚀 Redis ready'));
redis.on('end', () => console.log('🔌 Redis disconnected'));


//Cache&Sync
const cron = require('node-cron');
const axios = require('axios');

let productSyncInProgress = false;
let categorySyncInProgress = false;

const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

//console.log(`${UPSTASH_REDIS_REST_URL}.  ||  ${UPSTASH_REDIS_REST_TOKEN}`);

const cache = {
  set: async (key, value, ttl = 3600) => {
    try {
      const data = JSON.stringify(value);
      await axios.post(`${UPSTASH_REDIS_REST_URL}/set/${key}/${encodeURIComponent(data)}`, null, {
        headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
        params: { ex: ttl } 
      });
      return true;
    } catch (err) {
      console.error(`❌ Redis set error for key ${key}:`, err.message);
      return false;
    }
  },

  get: async (key) => {
    try {
      const res = await axios.get(`${UPSTASH_REDIS_REST_URL}/get/${key}`, {
        headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
      });
      if (res.data.result) {
        return JSON.parse(res.data.result);
      }
      return null;
    } catch (err) {
      console.error(`❌ Redis get error for key ${key}:`, err.message);
      return null;
    }
  },

  del: async (key) => {
    try {
      await axios.post(`${UPSTASH_REDIS_REST_URL}/del/${key}`, null, {
        headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
      });
      return true;
    } catch (err) {
      console.error(`❌ Redis delete error for key ${key}:`, err.message);
      return false;
    }
  },

  exists: async (key) => {
    try {
      const res = await axios.get(`${UPSTASH_REDIS_REST_URL}/exists/${key}`, {
        headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` }
      });
      return res.data.result === 1;
    } catch (err) {
      console.error(`❌ Redis exists error for key ${key}:`, err.message);
      return false;
    }
  }
};

async function syncWooData(caller = 'unknown') {
  if (productSyncInProgress) {
    console.log(`⏳ [syncWooData] Already in progress, called from ${caller}, skipping...`);
    return;
  }

  productSyncInProgress = true;
  try {
    console.log(`🌀 [syncWooData] Called from: ${caller} — Syncing WooCommerce products...`);
    let allProducts = [];
    const countRes = await api.get('products', { per_page: 100, min_price: 1, timeout: 30000 });
    const totalProducts = parseInt(countRes.headers['x-wp-total'] || 0);
    const totalPages = parseInt(countRes.headers['x-wp-totalpages'] || 1);

    for (let page = 1; page <= totalPages; page++) {
      let retries = 3;
      while (retries > 0) {
        try {
          const response = await api.get('products', { per_page: 100, page, timeout: 30000 });
          allProducts = allProducts.concat(response.data);
          break;
        } catch (err) {
          retries--;
          console.warn(`[syncWooData] Retry ${3 - retries} failed for page ${page}: ${err.message}`);
          if (retries === 0) throw err;
          await new Promise(r => setTimeout(r, 2000));
        }
      }
    }

    const validProducts = allProducts.filter(p => p.stock_status === 'instock' && parseFloat(p.price || 0) > 0);

    if (validProducts.length > 0) {
      const cacheSuccess = await cache.set('allProducts', validProducts);
      if (cacheSuccess) {
        console.log(`✅ [syncWooData] Redis cached ${validProducts.length} valid products`);
      } else {
        console.error(`❌ [syncWooData] Failed to cache products in Redis`);
      }
    } else {
      console.warn(`⚠️ [syncWooData] No valid products fetched, keeping old cache`);
    }

  } catch (err) {
    console.error(`❌ [syncWooData] WooCommerce sync failed (called from ${caller}): ${err.message}`);
  } finally {
    productSyncInProgress = false;
  }
}

async function syncWooCategories(caller = 'unknown') {
  if (categorySyncInProgress) {
    console.log(`⏳ [syncWooCategories] Already in progress, called from ${caller}, skipping...`);
    return;
  }

  categorySyncInProgress = true;
  try {
    console.log(`🌀 [syncWooCategories] Called from: ${caller} — Syncing WooCommerce categories...`);
    const PQueue = (await import('p-queue')).default;

    const categoryRes = await apiAxios.get('products/categories', { params: { per_page: 100 }, timeout: 10000 });
    const categories = categoryRes.data;
    const categoryMap = {};

    const queue = new PQueue({ concurrency: 10 });
    await Promise.all(categories.map(cat => queue.add(async () => {
      try {
        const productRes = await apiAxios.get('products', {
          params: { per_page: 1, category: cat.id, stock_status: 'instock' },
          timeout: 10000
        });
        const product = productRes.data[0];
        if (product?.images?.[0]?.src) {
          categoryMap[cat.id] = { id: cat.id, name: cat.name, image: product.images[0].src };
        }
      } catch {}
    })));

    await queue.onIdle();
    const categoriesArray = Object.values(categoryMap);
    if (categoriesArray.length > 0) {
      const cacheSuccess = await cache.set('allCategories', categoriesArray);
      if (cacheSuccess) {
        console.log(`✅ [syncWooCategories] Redis cached ${categoriesArray.length} categories`);
      } else {
        console.error(`❌ [syncWooCategories] Failed to cache categories in Redis`);
      }
    } else {
      console.warn(`⚠️ [syncWooCategories] No valid categories fetched, keeping old cache`);
    }

  } catch (err) {
    console.error(`❌ [syncWooCategories] Failed (called from ${caller}): ${err.message}`);
  } finally {
    categorySyncInProgress = false;
  }
}

async function syncCategoryProducts(categoryId) {
  try {
    const allProducts = [];
    let page = 1;

    while (true) {
      const response = await apiAxios.get('products', {
        params: {
          per_page: 100,
          page: page,
          category: categoryId,
          min_price: 1
        },
        timeout: 10000
      });

      if (!response.data || response.data.length === 0) break;

      allProducts.push(...response.data);
      if (response.data.length < 100) break;
      page++;
    }

    const cachedCategoryProducts = allProducts.filter(p => p.price && p.stock_status === 'instock');
    console.error(`Category Products Synced ${categoryId}  : ${cachedCategoryProducts.length},  ${cachedCategoryProducts.result} products:`);
    const isSuccess = await cache.set(`category_${categoryId}`, cachedCategoryProducts, 1800);
    if (isSuccess) {
      console.log(`✅ [syncWooCategories] Redis cached ${cachedCategoryProducts.length} categories`);
    } else {
      console.error(`❌ [syncWooCategories] Failed to cache categories in Redis`);
    }
    return cachedCategoryProducts;
  } catch (error) {
    console.error(`❌ Error syncing category ${categoryId} products:`, error.message);
    throw error;
  }
}

cron.schedule('*/15 * * * *', () => {
  console.log('🕒 Scheduled 15-min sync triggered...');
  syncWooData('cron schedule');
  syncWooCategories('cron schedule');
});

async function initializeApp() {
  try {
    await redis.connect();
    console.log('🔄 Initial data sync starting...');
    await syncWooData('app startup');
    await syncWooCategories('app startup');
    console.log('✅ App initialization complete');
  } catch (err) {
    console.error('❌ App initialization failed:', err.message);
  }
}


initializeApp();

app.get('/',async(req,res)=>{
try {
    // productSyncInProgress = false;
    // categorySyncInProgress = false;
    // await syncWooData();
    // await syncWooCategories();
    res.json({ success: true, message: 'API refreshed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/refreshCache', async (req, res) => {
  try {
    productSyncInProgress = false;
    await syncWooData('/refreshCache route');
    res.json({ success: true, message: 'Cache refreshed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/refreshCacheCategory', async (req, res) => {
  try {
    categorySyncInProgress = false;
    await syncWooCategories('/refreshCache route');
    res.json({ success: true, message: 'Cache refreshed successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/getallProducts', async (req, res) => {
  try {
    const skip = parseInt(req.query.skip) || 0;
    const limit = 20;

    const cachedProducts = await cache.get('allProducts');
    if (cachedProducts && cachedProducts.length > 0) {
      const products = cachedProducts.slice(skip, skip + limit);
      console.log(`Fetched from synced cache.`);
      res.status(200).json({
        success: true,
        source: 'cache',
        skip,
        nextSkip: skip + products.length,
        hasMore: skip + products.length < cachedProducts.length,
        totalProducts: cachedProducts.length,
        products
      });
      return;
    }

    const page = Math.floor(skip / limit) + 1;
    const response = await api.get('products', { per_page: limit, page, min_price: 1 });
    const rawProducts = response.data.filter(p => p.price);
    console.log(`Fetched from api.`);
    res.status(200).json({
      success: true,
      source: 'api',
      skip,
      nextSkip: skip + rawProducts.length,
      hasMore: rawProducts.length === limit,
      totalProducts: rawProducts.length,
      products: rawProducts
    });

    syncWooData('getallProducts route');
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch products',
      error: error.response?.data || error.message
    });
  }
});

app.get('/getallProductsOld', async (req, res) => {
  try {
   const skip = parseInt(req.query.skip) || 0;
    const limit = 20;

    const page = Math.floor(skip / limit) + 1;
    const offsetWithinPage = skip % limit;

    const response = await api.get('products', {
      per_page: limit,
      page: page,
      min_price: 1
    });

    const rawProducts = response.data;

    const filteredProducts = rawProducts.filter(p => {
      return p.price !== null && p.price !== '' && p.price !== undefined;
    });

    const products = rawProducts.slice(offsetWithinPage, offsetWithinPage + limit);
    const productsFilter = filteredProducts.slice(offsetWithinPage, offsetWithinPage + limit);

    res.status(200).json({
      success: true,
      skip: skip,
      nextSkip: skip + products.length,
      hasMore: products.length === limit,
      totalProducts: products.length,
      products: products,
      productsFilter : productsFilter
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch products',
      error: error.response?.data || error.message
    });
  }
});

app.get('/getCategoriesProduct', async (req, res) => {
  try {
    const skip = parseInt(req.query.skip) || 0;
    const limit = 20;
    const category = req.query.category;

    if (!category) {
      return res.status(400).json({
        success: false,
        message: "Missing required 'category' query parameter"
      });
    }

    const key = `category_${String(category).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    let cachedCategoryProducts = await cache.get(key);
    let source = 'cache';

    //console.log('cachedCategoryProducts :', cachedCategoryProducts,  cachedCategoryProducts.length);

     if (cachedCategoryProducts && Array.isArray(cachedCategoryProducts)) {
      cachedCategoryProducts = cachedCategoryProducts;
    } else {
      cachedCategoryProducts = await syncCategoryProducts(category);
      source = 'api';
    }

    console.log('cachedCategoryProducts length:', cachedCategoryProducts.length);

    cachedCategoryProducts = Array.isArray(cachedCategoryProducts) ? cachedCategoryProducts : [];

    const check = await cache.get(key);
    const arrayCheck = Array.isArray(check) ? check : [];
    const products = arrayCheck.slice(skip, skip + limit);

    res.status(200).json({
      success: true,
      source,
      category,
      skip,
      nextSkip: skip + products.length,
      hasMore: skip + products.length < cachedCategoryProducts.length,
      totalProducts: cachedCategoryProducts.length,
      products
    });

  } catch (error) {
    console.error("Woo API Error:", error.response?.data || error.message || error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch category products',
      error: error.response?.data || error.message
    });
  }
});

app.get('/getCategoriesProductOld', async (req, res) => {
  try {
    const skip = parseInt(req.query.skip) || 0;
    const limit = 20;
    const category = req.query.category;

    if (!category) {
      return res.status(400).json({
        success: false,
        message: "Missing required 'category' query parameter"
      });
    }

    const page = Math.floor(skip / limit) + 1;

    console.log("Fetching products for category:", category, "Page:", page);

    const response = await apiAxios.get('products', {
      params: {
        per_page: limit,
        page: page,
        category: category,
        min_price: 1
      },
      timeout: 10000
    });

    const products = response.data;

    res.status(200).json({
      success: true,
      category: category,
      skip: skip,
      nextSkip: skip + products.length,
      hasMore: products.length === limit,
      totalProducts: products.length,
      products: products
    });

  } catch (error) {
    console.error("Woo API Error:", error.response?.data || error.message || error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch category products',
      error: error.response?.data || error.message
    });
  }
});

//WithFilterSort
app.get('/getCategoriesProductWithSortFilterOld', async (req, res) => {
  try {
    const skip = parseInt(req.query.skip) || 0;
    const limit = 20;
    const category = req.query.category;
    const orderby = req.query.orderby || 'menu_order';
    const order = req.query.order || 'asc';
    const min_price = req.query.min_price;
    const max_price = req.query.max_price;
    const on_sale = req.query.on_sale;
    const stock_status = req.query.stock_status;

    if (!category) {
      return res.status(400).json({
        success: false,
        message: "Missing required 'category' query parameter"
      });
    }

    const page = Math.floor(skip / limit) + 1;

    console.log("Fetching products with filters:", {
      category,
      page,
      orderby,
      order,
      min_price,
      max_price,
      on_sale,
      stock_status
    });

    const wooCommerceParams = {
      per_page: limit,
      page: page,
      category: category,
      orderby: orderby,
      order: order
    };

    if (min_price) wooCommerceParams.min_price = min_price;
    if (max_price) wooCommerceParams.max_price = max_price;
    if (on_sale === 'true') wooCommerceParams.on_sale = true;
    if (stock_status) wooCommerceParams.stock_status = stock_status;

    const response = await apiAxios.get('products', {
      params: wooCommerceParams,
      timeout: 10000
    });

    let products = response.data;

    products = products.filter(product => {
      const price = product.price;
      return price && typeof price === 'string' && price.trim() !== '' && price !== '0';
    });

    if (min_price || max_price) {
      products = products.filter(product => {
        const price = parseFloat(product.price);
        return !isNaN(price) && 
               (!min_price || price >= parseFloat(min_price)) && 
               (!max_price || price <= parseFloat(max_price));
      });
    }

    res.status(200).json({
      success: true,
      category: category,
      skip: skip,
      nextSkip: skip + products.length,
      hasMore: products.length === limit, 
      totalProducts: products.length,
      products: products,
      appliedFilters: {
        orderby,
        order,
        min_price,
        max_price,
        on_sale,
        stock_status
      }
    });

  } catch (error) {
    console.error("Woo API Error:", error.response?.data || error.message || error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch category products',
      error: error.response?.data || error.message
    });
  }
});

app.get('/getCategoriesProductWithSortFilter', async (req, res) => {
  try {
    const skip = parseInt(req.query.skip) || 0;
    const limit = 20;
    const category = req.query.category;
    const orderby = req.query.orderby || 'menu_order';
    const order = req.query.order || 'asc';
    const min_price = req.query.min_price;
    const max_price = req.query.max_price;
    const on_sale = req.query.on_sale;
    const stock_status = req.query.stock_status;

    if (!category) {
      return res.status(400).json({
        success: false,
        message: "Missing required 'category' query parameter"
      });
    }

    console.log("Fetching products with filters:", {
      category,
      skip,
      orderby,
      order,
      min_price,
      max_price,
      on_sale,
      stock_status
    });

    // NEW: Fetch ALL products first, then paginate
    let allProducts = [];
    let currentPage = 1;
    const maxPages = 10; // Safety limit to prevent infinite loops

    while (currentPage <= maxPages) {
      const wooCommerceParams = {
        per_page: 100,
        page: currentPage,
        category: category,
        orderby: orderby,
        order: order
      };

      if (min_price) wooCommerceParams.min_price = min_price;
      if (max_price) wooCommerceParams.max_price = max_price;
      if (on_sale === 'true') wooCommerceParams.on_sale = true;
      if (stock_status) wooCommerceParams.stock_status = stock_status;

      const response = await apiAxios.get('products', {
        params: wooCommerceParams,
        timeout: 10000
      });

      let products = response.data;

      // Filter out invalid products
      products = products.filter(product => {
        const price = product.price;
        return price && typeof price === 'string' && price.trim() !== '' && price !== '0';
      });

      // Apply price range filtering
      if (min_price || max_price) {
        products = products.filter(product => {
          const price = parseFloat(product.price);
          return !isNaN(price) && 
                 (!min_price || price >= parseFloat(min_price)) && 
                 (!max_price || price <= parseFloat(max_price));
        });
      }

      // If no products returned, break the loop
      if (products.length === 0) {
        break;
      }

      allProducts = allProducts.concat(products);
      
      // If we got less than 100 products, we've reached the end
      if (products.length < 100) {
        break;
      }

      currentPage++;
    }

    // Apply manual sorting if needed
    if (orderby === 'price') {
      allProducts.sort((a, b) => {
        const priceA = parseFloat(a.price);
        const priceB = parseFloat(b.price);
        
        if (order === 'desc') {
          return priceB - priceA; 
        } else {
          return priceA - priceB; 
        }
      });
    }

    // Now apply pagination to the fully sorted list
    const startIndex = skip;
    const endIndex = Math.min(startIndex + limit, allProducts.length);
    const paginatedProducts = allProducts.slice(startIndex, endIndex);

    res.status(200).json({
      success: true,
      category: category,
      skip: skip,
      nextSkip: endIndex,
      hasMore: endIndex < allProducts.length,
      totalProducts: allProducts.length,
      products: paginatedProducts,
      appliedFilters: {
        orderby,
        order,
        min_price,
        max_price,
        on_sale,
        stock_status
      }
    });

  } catch (error) {
    console.error("Woo API Error:", error.response?.data || error.message || error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch category products',
      error: error.response?.data || error.message
    });
  }
});

//HomeCategories
app.get('/getAllCategoriesWithOneProductImage', async (req, res) => {
  try {
    let categories = await cache.get('allCategories');

    if (categories && categories.length > 0) {
      console.log('Fetched from cache');
      res.status(200).json({ success: true, source: 'cache', totalCategories: categories.length, categories });
      //syncWooCategories('getAllCategoriesRoute route');
      return;
    }

    console.log('⚠️ Category cache empty — fetching directly for fast response...');
    const categoryRes = await apiAxios.get('products/categories', { params: { per_page: 100 }, timeout: 10000 });
    const allCategories = categoryRes.data;

    const categoriesWithImage = await Promise.all(
      allCategories.map(async (cat) => {
        try {
          const productRes = await apiAxios.get('products', {
            params: { per_page: 1, category: cat.id, stock_status: 'instock' },
            timeout: 10000
          });
          const product = productRes.data[0];
          if (product && product.images?.length > 0 && product.images[0].src) {
            return { id: cat.id, name: cat.name, image: product.images[0].src };
          }
          return null;
        } catch {
          return null;
        }
      })
    );

    categories = categoriesWithImage.filter(Boolean);
    res.status(200).json({ success: true, source: 'api', totalCategories: categories.length, categories });

    syncWooCategories('getAllCategoriesRoute route');
  } catch (err) {
    console.error("Error fetching categories:", err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch categories', error: err.message });
  }
});

app.get('/getAllCategoriesWithOneProductImageOld', async (req, res) => {
  try {
    const categoryRes = await apiAxios.get('products/categories', {
      params: {
        per_page: 100
      },
      timeout: 10000
    });

    const categories = categoryRes.data;

    const filteredCategories = await Promise.all(categories.map(async (cat) => {
      try {
        const productRes = await apiAxios.get('products', {
          params: {
            per_page: 1,
            category: cat.id,
            stock_status: 'instock',
          },
          timeout: 10000
        });

        const product = productRes.data[0];

        if (product && product.images && product.images.length > 0 && product.images[0].src) {
          return {
            id: cat.id,
            name: cat.name,
            image: product.images[0].src
          };
        }

        return null;
      } catch (err) {
        return null;
      }
    }));

    const validCategories = filteredCategories.filter(item => item !== null);

    res.status(200).json({
      success: true,
      totalCategories: validCategories.length,
      categories: validCategories
    });

  } catch (error) {
    console.error("Error fetching categories:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch filtered categories',
      error: error.response?.data || error.message
    });
  }
});

app.get('/getHomePageBanners', async (req, res) => {
  try {
    const banners = [
      {
        image: 'https://updateavenues.com/wp-content/uploads/2025/07/m.png',
        clickable: true,
        name: 'SHOP NOW',
        catId : '33',
        catName : 'Women'
      },
      {
        image: 'https://updateavenues.com/wp-content/uploads/2025/07/pjg-1.png',
        clickable: true,
        name: 'SHOP NOW',
        catId : '33',
        catName : 'Women'
      },
      {
        image: 'https://updateavenues.com/wp-content/uploads/2025/07/HH-1.png',
        clickable: true,
        name: 'SHOP NOW',
        catId : '33',
        catName : 'Women'
      }
    ];

    res.json({
      success: true,
      total: banners.length,
      banners
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

//SpecificProducts
app.get('/getSpecificProducts', async (req, res) => {
  try {
    const productIds = req.query.ids;
    
    if (!productIds) {
      return res.status(400).json({
        success: false,
        message: 'Product IDs are required. Use ?ids=id1,id2,id3 format'
      });
    }

    const idsArray = productIds.split(',').map(id => id.trim()).filter(id => id !== '');
    
    if (idsArray.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid product IDs provided'
      });
    }

    const batchSize = 20; 
    const allProducts = [];

    for (let i = 0; i < idsArray.length; i += batchSize) {
      const batchIds = idsArray.slice(i, i + batchSize);
      
      const response = await api.get('products', {
        include: batchIds.join(','),
        per_page: batchSize
      });

      if (response.data && Array.isArray(response.data)) {
        allProducts.push(...response.data);
      }
      
      if (i + batchSize < idsArray.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    const validProducts = allProducts.filter(p => {
      return p && p.price !== null && p.price !== '' && p.price !== undefined;
    });

    res.status(200).json({
      success: true,
      totalRequested: idsArray.length,
      totalFound: validProducts.length,
      products: validProducts,
      missingProducts: idsArray.length - validProducts.length
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch specific products',
      error: error.response?.data || error.message
    });
  }
});

app.get('/getOnlyOneProduct', async (req, res) => {
  try {
    const productId = req.query.id;
    
    if (!productId) {
      return res.status(400).json({
        success: false,
        message: 'Product ID is required. Use ?id=product_id format'
      });
    }

    if (isNaN(Number(productId))) {
      return res.status(400).json({
        success: false,
        message: 'Invalid product ID format. Must be a numeric value'
      });
    }

    const response = await api.get(`products/${productId}`);
    
    if (!response.data || response.data.price === null || response.data.price === '' || response.data.price === undefined) {
      return res.status(404).json({
        success: false,
        message: 'Product not found or has invalid price data',
        productId: productId
      });
    }

    res.status(200).json({
      success: true,
      product: response.data
    });

  } catch (error) {
    if (error.response?.status === 404) {
      return res.status(404).json({
        success: false,
        message: 'Product not found',
        productId: req.query.id,
        error: 'Product does not exist'
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to fetch product',
      productId: req.query.id,
      error: error.response?.data || error.message
    });
  }
});

app.listen(PORT,'192.168.29.145', () => {
  console.log(`Server running on http://192.168.29.145:${PORT}`);
});