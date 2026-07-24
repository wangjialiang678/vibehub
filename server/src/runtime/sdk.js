/**
 * VibeHub 作品运行时 SDK —— 由平台在部署时自动注入每个 HTML 页面。
 * 学员（和学员的 AI）不需要安装、不需要 key，直接用 window.vibehub。
 *
 * 注意：作品是公开网页，这里没有也不会有任何密钥。
 * 项目身份由服务端从作品 URL 推导，配额与限流都在服务端强制。
 */
(function () {
  var BASE = '/baas/v1';
  var here = location.pathname;

  function req(method, path, body, isForm) {
    var opts = {
      method: method,
      headers: { 'x-vibehub-project': here },
      credentials: 'omit',
    };
    if (body !== undefined) {
      if (isForm) opts.body = body;
      else { opts.headers['content-type'] = 'application/json'; opts.body = JSON.stringify(body); }
    }
    return fetch(BASE + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error((d.error && d.error.message) || ('请求失败 ' + r.status));
        return d;
      });
    });
  }

  var ns = 'vh:' + here + ':';

  window.vibehub = {
    /** 存一条数据 */
    save: function (collection, data) { return req('POST', '/' + encodeURIComponent(collection), data); },
    /** 读数据列表（默认按时间倒序） */
    list: function (collection, opts) {
      var q = opts && opts.limit ? '?limit=' + Number(opts.limit) : '';
      return req('GET', '/' + encodeURIComponent(collection) + q).then(function (d) { return d.items || []; });
    },
    /** 删一条 */
    remove: function (collection, id) {
      return req('DELETE', '/' + encodeURIComponent(collection) + '/' + encodeURIComponent(id));
    },
    /** 上传文件，返回可直接用在 <img src> / <audio src> 的地址 */
    upload: function (file) {
      var fd = new FormData();
      fd.append('file', file);
      return req('POST', '/files', fd, true).then(function (d) { return d.url; });
    },
    /** 计数器自增，返回新值 */
    counter: function (key) { return req('POST', '/counter/' + encodeURIComponent(key)).then(function (d) { return d.value; }); },

    /**
     * 本地存储。所有作品共享同一个域名（路径式网址的代价），
     * 用它而不是裸 localStorage，避免和别人的作品互相覆盖。
     */
    storage: {
      get: function (k) { try { return JSON.parse(localStorage.getItem(ns + k)); } catch (e) { return null; } },
      set: function (k, v) { try { localStorage.setItem(ns + k, JSON.stringify(v)); } catch (e) {} },
      remove: function (k) { try { localStorage.removeItem(ns + k); } catch (e) {} },
    },
  };
})();
