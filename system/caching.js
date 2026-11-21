class Caching {
    constructor(cacheTtl = 180000, nullCacheTtl = 60000) {
        this.cache = new Map();
        this.cacheTtl = cacheTtl;
        this.nullCacheTtl = nullCacheTtl;
    }

    setCache(key, value, ttl) {
        this.cache.set(key, {
            value: value,
            timestamp: Date.now() + ttl
        });
    }

    getCache(key) {
        if (this.cache.has(key)) {
            const cacheEntry = this.cache.get(key);
            if (Date.now() < cacheEntry.timestamp) {
                return cacheEntry.value; // Ini udah return value langsung
            } else {
                this.cache.delete(key);
            }
        }
        return null;
    }

    async cacheFunction(key, func) {
        try {
            const result = await func();
            // Jika hasil fetch gagal (null/undefined)
            if (result === null || result === undefined) {
                const cachedValue = this.getCache(key);
                // Gunakan cache lama kalau masih ada
                if (cachedValue !== null) {
                    this.setCache(key, cachedValue, this.cacheTtl);
                    return cachedValue; // Kembalikan cache lama
                }
            } else {
                this.setCache(key, result, this.cacheTtl);
            }
            return result;
        } catch (error) {
            console.error("Error executing function:", error);
            return this.getCache(key); // Fallback ke cache kalau error
        }
    }
}

// 1. Definisikan instance di sini agar menjadi satu-satunya sumber kebenaran (Singleton)
const groupCache = new Caching(180000); // TTL 3 menit untuk grup
const ppCache = new Caching(3600000); // TTL 1 jam untuk foto profil

// 2. Export instance tersebut
export { groupCache, ppCache };

// 3. Masih bisa export class-nya jika suatu saat butuh buat instance custom
export default Caching;