(function () {
  "use strict";

  // ---- DOM refs -------------------------------------------------------
  const bvInput = document.getElementById("bvInput");
  const folderInput = document.getElementById("folderInput");
  const downloadBtn = document.getElementById("downloadBtn");
  const taskList = document.getElementById("taskList");
  const doneContainer = document.getElementById("doneList");
  const tabs = document.querySelectorAll(".tab");
  const settingsBtn = document.getElementById("settingsBtn");
  const settingsModal = document.getElementById("settingsModal");
  const closeSettings = document.getElementById("closeSettingsBtn");
  const dlPathInput = document.getElementById("downloadPathInput");
  const changePathBtn = document.getElementById("changePathBtn");

  // ---- State -----------------------------------------------------------
  var activeConnections = {};

  // ---- Utilities -------------------------------------------------------
  function showToast(msg) {
    var el = document.querySelector(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._hide);
    el._hide = setTimeout(function () { el.classList.remove("show"); }, 3000);
  }

  function fmtSize(b) {
    if (!b || b <= 0) return "";
    if (b > 1073741824) return (b / 1073741824).toFixed(1) + " GB";
    if (b > 1048576) return (b / 1048576).toFixed(1) + " MB";
    if (b > 1024) return (b / 1024).toFixed(0) + " KB";
    return b + " B";
  }

  function fmtDuration(s) {
    if (!s || s <= 0) return "";
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (h) return h + ":" + String(m).padStart(2, "0") + ":" + String(sec).padStart(2, "0");
    return m + ":" + String(sec).padStart(2, "0");
  }

  function esc(s) {
    var d = document.createElement("div");
    d.appendChild(document.createTextNode(s));
    return d.innerHTML;
  }

  function pathBasename(p) {
    return p.replace(/\\/g, "/").split("/").pop();
  }

  // ---- Tabs ------------------------------------------------------------
  tabs.forEach(function (btn) {
    btn.addEventListener("click", function () {
      tabs.forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      var isActive = btn.dataset.tab === "active";
      document.getElementById("tabActive").classList.toggle("hidden", !isActive);
      document.getElementById("tabDone").classList.toggle("hidden", isActive);
      if (!isActive) refreshDoneList();
    });
  });

  // ---- Settings --------------------------------------------------------
  settingsBtn.addEventListener("click", function () {
    loadSettings();
    settingsModal.classList.remove("hidden");
  });

  closeSettings.addEventListener("click", function () {
    settingsModal.classList.add("hidden");
  });
  settingsModal.addEventListener("click", function (e) {
    if (e.target === settingsModal) settingsModal.classList.add("hidden");
  });

  changePathBtn.addEventListener("click", function () {
    fetch("/api/select-folder", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.success && d.path) {
          dlPathInput.value = d.path;
          showToast("下载目录已更新");
        }
      })
      .catch(function () { showToast("选择目录失败"); });
  });

  function loadSettings() {
    fetch("/api/config")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        dlPathInput.value = d.download_path || "使用默认目录";
      })
      .catch(function () {});
  }

  // ---- Download --------------------------------------------------------
  downloadBtn.addEventListener("click", startDownloads);

  function startDownloads() {
    var bvs = bvInput.value.trim().split("\n")
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s; });
    var folderName = folderInput.value.trim();

    if (!bvs.length) { showToast("请输入 BV 号"); return; }

    downloadBtn.disabled = true;

    // Switch to active tab
    tabs.forEach(function (b) { b.classList.remove("active"); });
    tabs[0].classList.add("active");
    document.getElementById("tabActive").classList.remove("hidden");
    document.getElementById("tabDone").classList.add("hidden");

    function next() {
      if (!bvs.length) {
        downloadBtn.disabled = false;
        return;
      }
      var bv = bvs.shift();
      startOne(bv, folderName).then(next, function (e) {
        showToast("下载 " + bv + " 失败: " + e.message);
        next();
      });
    }
    next();
  }

  function startOne(bv, folderName) {
    return fetch("/api/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bv: bv })
    })
    .then(function (r) { return r.json(); })
    .then(function (info) {
      if (!info.success) throw new Error(info.error || "获取信息失败");
      return fetch("/api/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bv: bv, folder_name: folderName })
      })
      .then(function (r) { return r.json(); })
      .then(function (dl) {
        if (dl.error) throw new Error(dl.error);
        addTaskCard(dl.task_id, info);
        listenProgress(dl.task_id);
      });
    });
  }

  function addTaskCard(taskId, info) {
    var hint = taskList.querySelector(".empty-hint");
    if (hint) hint.remove();

    var card = document.createElement("div");
    card.className = "task-card";
    card.id = "task-" + taskId;

    card.innerHTML =
      '<div class="thumb">' +
        (info.thumbnail
          ? '<img src="' + esc(info.thumbnail) + '" alt="" crossorigin="anonymous">'
          : "封面") +
      "</div>" +
      '<div class="info">' +
        '<div class="title" title="' + esc(info.title) + '">' + esc(info.title) + "</div>" +
        '<div class="meta">' + esc(info.uploader) + " &middot; " + fmtDuration(info.duration) + "</div>" +
        '<div class="progress-bar"><div class="fill downloading" style="width:0%"></div></div>' +
      "</div>" +
      '<span class="status-tag downloading">准备中</span>';

    taskList.appendChild(card);
  }

  // ---- SSE Progress ----------------------------------------------------
  function listenProgress(taskId) {
    var es = new EventSource("/api/progress/" + taskId);
    activeConnections[taskId] = es;

    es.onmessage = function (e) {
      try {
        var data = JSON.parse(e.data);
        updateCard(taskId, data);

        if (data.status === "completed" || data.status === "error" || data.status === "cancelled") {
          es.close();
          delete activeConnections[taskId];
          if (data.status === "completed") showToast("下载完成！");
        }
      } catch (_) {}
    };

    es.onerror = function () {
      es.close();
      delete activeConnections[taskId];
    };
  }

  function updateCard(taskId, data) {
    var card = document.getElementById("task-" + taskId);
    if (!card) return;

    var tag = card.querySelector(".status-tag");
    var bar = card.querySelector(".fill");

    var label = {
      queued: "排队中",
      fetching: "获取信息",
      downloading: "下载中",
      merging: "合并中",
      completed: "已完成",
      error: "失败"
    }[data.status] || data.status;

    tag.textContent = label;
    tag.className = "status-tag " + (data.status || "");

    if (bar) {
      if (data.status === "error") {
        bar.style.width = "100%";
        bar.style.background = "#e53935";
      } else {
        bar.style.width = (data.progress || 0) + "%";
      }
    }

    if (data.status === "completed" && !card.querySelector(".open-btn")) {
      var btn = document.createElement("button");
      btn.className = "open-btn";
      btn.textContent = "打开文件夹";
      btn.addEventListener("click", function () {
        // open the downloads directory
        fetch("/api/config")
          .then(function (r) { return r.json(); })
          .then(function (cfg) {
            var dir = cfg.download_path || "";
            fetch("/api/open", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: dir || "downloads" })
            });
          })
          .catch(function () { showToast("无法打开文件夹"); });
      });
      card.appendChild(btn);
    }
  }

  // ---- Done list -------------------------------------------------------
  function refreshDoneList() {
    fetch("/api/list")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        doneContainer.innerHTML = "";
        if (!d.videos || !d.videos.length) {
          doneContainer.innerHTML = '<p class="empty-hint">暂无已下载视频</p>';
          return;
        }
        d.videos.forEach(function (v) {
          var card = document.createElement("div");
          card.className = "task-card";

          var btn = document.createElement("button");
          btn.className = "open-btn";
          btn.textContent = "打开文件";
          btn.addEventListener("click", function () {
            fetch("/api/open", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: v.path })
            }).catch(function () { showToast("无法打开文件"); });
          });

          card.innerHTML =
            '<div class="thumb">&#127916;</div>' +
            '<div class="info">' +
              '<div class="title" title="' + esc(v.title) + " - " + esc(pathBasename(v.path)) + '">' + esc(v.title) + "</div>" +
              '<div class="meta">' + fmtSize(v.size) + " &middot; " + new Date(v.modified * 1000).toLocaleDateString() + "</div>" +
            "</div>";
          card.appendChild(btn);
          doneContainer.appendChild(card);
        });
      })
      .catch(function () {
        doneContainer.innerHTML = '<p class="empty-hint">加载失败</p>';
      });
  }

  // ---- Init -----------------------------------------------------------
  loadSettings();
  // Pre-populate empty hints
  taskList.innerHTML = '<p class="empty-hint">暂无下载任务</p>';
  doneContainer.innerHTML = '<p class="empty-hint">暂无已下载视频</p>';

})();
