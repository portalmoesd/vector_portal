/**
 * Fetch wrapper with JWT authentication.
 */
const Api = {
  getToken() {
    return localStorage.getItem('token');
  },

  setToken(token) {
    localStorage.setItem('token', token);
  },

  clearToken() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  },

  getUser() {
    const raw = localStorage.getItem('user');
    return raw ? JSON.parse(raw) : null;
  },

  setUser(user) {
    localStorage.setItem('user', JSON.stringify(user));
  },

  async request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = this.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const opts = { method, headers };
    if (body && method !== 'GET') {
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(`${API_BASE}${path}`, opts);

    if (res.status === 401) {
      this.clearToken();
      window.location.href = '/login.html';
      throw new Error('Unauthorized');
    }

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Request failed');
    return data;
  },

  get(path) { return this.request('GET', path); },
  post(path, body) { return this.request('POST', path, body); },
  put(path, body) { return this.request('PUT', path, body); },
  patch(path, body) { return this.request('PATCH', path, body); },
  delete(path) { return this.request('DELETE', path); },
};

function blobDownload(url, fileName) {
  return fetch(url, { headers: { 'Authorization': 'Bearer ' + Api.getToken() } })
    .then(r => {
      if (!r.ok) return r.json().then(d => { throw new Error(d.error || 'Download failed'); });
      return r.blob();
    })
    .then(blob => {
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    });
}

function downloadFileAuth(fileId, fileName) {
  blobDownload('/api/workflow/files/download?id=' + fileId, fileName).catch(err => alert(err.message));
}

function downloadEventFileAuth(eventId, fileId, fileName) {
  blobDownload(`/api/events/${eventId}/files/${fileId}/download`, fileName).catch(err => alert(err.message));
}
