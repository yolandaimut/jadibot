class Queue {
    constructor() {
        this.queues = {};
        this.processing = {};
    }

    /**
     * Tambahkan item ke antrean user/chat tertentu
     */
    add(id, item) {
        if (!this.queues[id]) {
            this.queues[id] = [];
            this.processing[id] = false;
        }
        this.queues[id].push(item);
    }

    /**
     * Cek apakah antrean kosong
     */
    isEmpty(id) {
        return !this.queues[id] || this.queues[id].length === 0;
    }

    /**
     * Proses antrean secara sequential
     * @param {string} id - userId / chatId
     * @param {function} callback - fungsi yang akan dipanggil untuk setiap item
     * @param {number} delayMs - delay antar item (ms). Sangat recommended untuk bot WA (500-1000ms)
     */
    async processQueue(id, callback, delayMs = 0) {
        // Jika sedang proses atau antrean kosong → skip
        if (this.processing[id] || this.isEmpty(id)) return;

        this.processing[id] = true;

        while (!this.isEmpty(id)) {
            const currentItem = this.queues[id][0];

            try {
                await callback(currentItem);
            } catch (error) {
                console.error(`[QUEUE ERROR] Memproses item untuk ID ${id}:`, error.message);
            } finally {
                // WAJIB pakai finally! Item harus dihapus baik sukses maupun error
                if (this.queues[id]) {
                    this.queues[id].shift();
                }
            }

            // Delay antar pengiriman (hindari rate limit WhatsApp)
            if (delayMs > 0 && !this.isEmpty(id)) {
                await new Promise(resolve => setTimeout(resolve, delayMs));
            }
        }

        // Bersihkan memory setelah antrean habis
        delete this.queues[id];
        delete this.processing[id];
    }
}

export default Queue;