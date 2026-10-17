const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NOTIFICATIONS_FILE = path.join(__dirname, '..', 'data', 'notifications.json');

class NotificationManager {
  constructor() {
    this.notifications = [];
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(NOTIFICATIONS_FILE)) {
        const raw = fs.readFileSync(NOTIFICATIONS_FILE, 'utf8');
        this.notifications = JSON.parse(raw);
      } else {
        this.save();
      }
    } catch (e) {
      this.notifications = [];
    }
  }

  save() {
    try {
      fs.writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(this.notifications.slice(0, 100), null, 2), 'utf8');
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
