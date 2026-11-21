import lid from './lid.js';

class Caching {
    constructor(cacheTtl = 600000) { // Default TTL: 10 Menit (600.000 ms)
        this.cache = new Map();
        this.pendingRequests = new Map(); // Untuk Promise Deduping (Anti-Spam Paralel)
        this.cacheTtl = cacheTtl;
    }

    async cacheFunction(key, func) {
        const now = Date.now();
        const cached = this.cache.get(key);

        // 1. Cek Cache Valid: Jika belum expired, langsung return tanpa hit API
        if (cached && now < cached.expiresAt) {
            return cached.data;
        }

        // 2. Promise Deduping: Jika detik ini sedang fetch API (request lain), numpang nunggu aja!
        if (this.pendingRequests.has(key)) {
            return await this.pendingRequests.get(key);
        }

        // 3. Tarik Data Baru dari API WA
        const fetchPromise = (async () => {
            try {
                const result = await func();
                
                if (result) {
                    // FIX ERROR: Langsung pass seluruh hasil ke lid.js seperti kodemu aslinya!
                    const processedResult = lid.updateParticipantsToPN(result);
                    
                    // Simpan ke memory cache
                    this.cache.set(key, {
                        data: processedResult,
                        expiresAt: Date.now() + this.cacheTtl
                    });
                    return processedResult;
                }

                // SMART FALLBACK: Jika API WA mengembalikan null tapi kita punya data basi
                if (cached) {
                    // Perpanjang "nyawa" data basi selama 1 menit agar bot gak nyepam API yang lagi error
                    this.cache.set(key, { ...cached, expiresAt: Date.now() + 60000 });
                    return cached.data;
                }
                
                return null;
            } catch (error) {
                console.error(`[GROUP-FETCH] ✗ Error mengeksekusi fetch API untuk key ${key}:`, error);
                if (cached) return cached.data; // Fallback data lama saat error
                return null;
            } finally {
                // Selalu bersihkan antrian setelah selesai (sukses/gagal)
                this.pendingRequests.delete(key);
            }
        })();

        // Daftarkan tiket antrian
        this.pendingRequests.set(key, fetchPromise);
        return await fetchPromise;
    }

    // Mengembalikan getCache barangkali masih ada file lama yang memanggil fungsi ini secara manual
    getCache(key) {
        const now = Date.now();
        const cached = this.cache.get(key);
        if (cached && now < cached.expiresAt) {
            return cached.data;
        }
        return null;
    }

    // Fitur tambahan jika sewaktu-waktu butuh reset cache manual
    clearCache(key) {
        if (key) {
            this.cache.delete(key);
        } else {
            this.cache.clear();
        }
    }
}

export default new Caching();