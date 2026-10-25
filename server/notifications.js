const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NOTIFICATIONS_FILE = path.join(__dirname, '..', 'data', 'notifications.json');

function atomicWriteJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch (e) {}
    throw err;
  }
}

class NotificationManager {
  constructor() {
    this.notifications = [];
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(NOTIFICATIONS_FILE)) {
        const raw = fs.readFileSync(NOTIFICATIONS_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        this.notifications = Array.isArray(parsed) ? parsed : [];
      } else {
        this.save();
      }
    } catch (e) {
      this.notifications = [];
    }
  }

  save() {
    try {
      atomicWriteJson(NOTIFICATIONS_FILE, this.notifications.slice(0, 100));
    } catch (e) {}
  }

  add(title, message, type = 'info') {
    const item = {
      id: 'notif_' + crypto.randomUUID(),
      title,
      message,
      type, // 'info' | 'success' | 'warning' | 'update'
      read: false,
      timestamp: new Date().toISOString()
    };
    this.notifications.unshift(item);
    if (this.notifications.length > 100) {
      this.notifications = this.notifications.slice(0, 100);
    }
    this.save();
    return item;
  }

  getAll() {
    return [...this.notifications];
  }

  getUnreadCount() {
    return this.notifications.filter(n => !n.read).length;
  }

  markAllRead() {
    this.notifications.forEach(n => n.read = true);
    this.save();
  }

  clear() {
    this.notifications = [];
    this.save();
  }
}

module.exports = new NotificationManager();
