import { jidNormalizedUser } from '@whiskeysockets/baileys';

class Socket {
    constructor() {
        this.socketMap = new Map();
    }

    // HELPER: Memastikan nomor yang dijadikan key selalu seragam dan bersih
    _normalizeKey(number) {
        if (!number) return '';
        let str = number.toString();
        // Kalau gak ada buntutnya, tambahin default WA net
        if (!str.includes('@')) str += '@s.whatsapp.net'; 
        return jidNormalizedUser(str);
    }

    // Menyimpan socket dengan nomor tertentu
    set(number, socket) {
        const key = this._normalizeKey(number);
        this.socketMap.set(key, socket);
    }

    // Mengambil socket berdasarkan nomor (Tanpa spam console)
    get(number) {
        const key = this._normalizeKey(number);
        return this.socketMap.get(key) || null;
    }

    // Menghapus socket berdasarkan nomor (Tanpa spam console)
    delete(number) {
        const key = this._normalizeKey(number);
        this.socketMap.delete(key);
    }

    // Mengecek apakah socket ada berdasarkan nomor
    cek(number) {
        const key = this._normalizeKey(number);
        return this.socketMap.has(key);
    }

    // Mendapatkan jumlah socket yang tersimpan
    size() {
        return this.socketMap.size;
    }

    // Menghapus semua socket
    clear() {
        this.socketMap.clear();
    }

    // Mengambil semua socket dalam bentuk array
    getAllSockets() {
        return Array.from(this.socketMap.values());
    }

    // Mendapatkan socket berdasarkan indeks
    getSocketByIndex(index) {
        if (index < 0 || index >= this.socketMap.size) {
            throw new Error("Index out of range.");
        }
        return Array.from(this.socketMap.values())[index];
    }
}

export default new Socket();