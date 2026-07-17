import os,sys,json,time,uuid,threading,subprocess,webbrowser,re
from pathlib import Path
from flask import Flask,request,jsonify,Response,render_template,stream_with_context

try:
    import yt_dlp
    YT_DLP_AVAILABLE=True
except ImportError:
    YT_DLP_AVAILABLE=False

try:
    import imageio_ffmpeg
    FFMPEG_PATH=imageio_ffmpeg.get_ffmpeg_exe()
except Exception:
    FFMPEG_PATH=None

BASE_DIR=Path(sys.executable).parent if getattr(sys,"frozen",False) else Path(__file__).parent
_MEI=Path(sys._MEIPASS) if getattr(sys,"frozen",False) else BASE_DIR
CONFIG_FILE=BASE_DIR/"config.json"
DEFAULT_DOWNLOADS=BASE_DIR/"downloads"

_config={"download_path":"","api_key":""}
_config_lock=threading.Lock()

def _load_config():
    global _config
    if CONFIG_FILE.exists():
        _config=json.loads(CONFIG_FILE.read_text("utf-8"))
    else:
        _save_config()

def _save_config():
    with _config_lock:
        CONFIG_FILE.write_text(json.dumps(_config,ensure_ascii=False,indent=2),"utf-8")

def _get_download_path():
    p=_config.get("download_path","")
    return p if p and Path(p).exists() else str(DEFAULT_DOWNLOADS)

_tasks={}
_tasks_lock=threading.Lock()

def _task_set(task_id,**kw):
    with _tasks_lock:
        _tasks.setdefault(task_id,{}).update(kw)

def _task_get(task_id):
    with _tasks_lock:
        return _tasks.get(task_id,{})

def _extract_bv(text):
    text=text.strip()
    if 'bilibili.com' in text or 'b23.tv' in text:
        m=re.search(r'BV[a-zA-Z0-9]+',text)
        if m:
            return m.group(0)
    return text

app=Flask(__name__,template_folder=str(_MEI/"templates"),static_folder=str(_MEI/"static"))

@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/config",methods=["GET","POST"])
def api_config():
    if request.method=="POST":
        data=request.json or {}
        if "download_path" in data:
            _config["download_path"]=data["download_path"]
            _save_config()
            return jsonify(success=True,download_path=_config["download_path"])
    return jsonify(download_path=_config.get("download_path",""))

@app.route("/api/select-folder",methods=["POST"])
def api_select_folder():
    try:
        import tkinter as tk
        from tkinter import filedialog
        root=tk.Tk()
        root.withdraw()
        root.attributes("-topmost",True)
        folder=filedialog.askdirectory(title="选择视频保存目录")
        root.destroy()
        if folder:
            _config["download_path"]=folder
            _save_config()
            return jsonify(success=True,path=folder)
        return jsonify(success=False,path=None)
    except Exception as e:
        return jsonify(success=False,error=str(e))

@app.route("/api/open",methods=["POST"])
def api_open():
    data=request.json or {}
    path=data.get("path","")
    if path:
        full=str(Path(path).resolve())
        if os.path.isfile(full):
            subprocess.Popen(["explorer","/select,",full])
        elif os.path.isdir(full):
            subprocess.Popen(["explorer",full])
        else:
            return jsonify(success=False,error="路径不存在"),404
        return jsonify(success=True)
    return jsonify(success=False,error="未提供路径"),400

@app.route("/api/info",methods=["POST"])
def api_info():
    bv=_extract_bv((request.json or {}).get("bv",""))
    if not bv:
        return jsonify(error="请输入 BV 号"),400
    if not YT_DLP_AVAILABLE:
        return jsonify(error="yt-dlp 未安装"),500
    try:
        ydl=yt_dlp.YoutubeDL({"quiet":True,"no_warnings":True})
        info=ydl.extract_info(f"https://www.bilibili.com/video/{bv}",download=False)
        resolutions=sorted(set(f.get("height",0) for f in info.get("formats",[]) if f.get("height")),reverse=True)
        return jsonify(success=True,title=info.get("title",""),duration=info.get("duration",0),uploader=info.get("uploader",""),thumbnail=info.get("thumbnail",""),bv=bv,resolutions=[f"{r}p" for r in resolutions if r>0])
    except Exception as e:
        err=str(e)
        if "404" in err or "Not Found" in err:
            msg="视频不存在，请检查 BV 号是否正确"
        else:
            msg=f"获取信息失败: {err[:100]}"
        return jsonify(error=msg),500

@app.route("/api/download",methods=["POST"])
def api_download():
    data=request.json or {}
    bv=_extract_bv(data.get("bv",""))
    folder_name=data.get("folder_name","").strip()
    if not bv:
        return jsonify(error="请输入 BV 号"),400
    if not YT_DLP_AVAILABLE:
        return jsonify(error="yt-dlp 未安装"),500
    dl_path=_get_download_path()
    Path(dl_path).mkdir(parents=True,exist_ok=True)
    task_id=str(uuid.uuid4())
    # 文件夹名：用户自定义 > BV号
    sub_dir=folder_name if folder_name else bv
    _task_set(task_id,bv=bv,status="queued",title="",progress=0,speed="",eta="",downloaded_bytes=0,total_bytes=0)
    threading.Thread(target=_download_worker,args=(bv,task_id,dl_path,sub_dir),daemon=True).start()
    return jsonify(task_id=task_id)

@app.route("/api/progress/<task_id>")
def api_progress(task_id):
    def _stream():
        while True:
            t=_task_get(task_id)
            if t:
                yield f"data: {json.dumps(t)}\n\n"
                if t.get("status") in ("completed","error","cancelled"):
                    break
            time.sleep(0.3)
    return Response(stream_with_context(_stream()),mimetype="text/event-stream")

@app.route("/api/list")
def api_list():
    dl_path=_get_download_path()
    videos=[]
    if Path(dl_path).exists():
        for bv_dir in Path(dl_path).iterdir():
            if bv_dir.is_dir():
                for f in bv_dir.iterdir():
                    if f.suffix.lower() in (".mp4",".mkv",".webm"):
                        videos.append(dict(title=f.stem,path=str(f),size=f.stat().st_size,modified=f.stat().st_mtime))
        videos.sort(key=lambda v:v["modified"],reverse=True)
    return jsonify(videos=videos)

def _download_worker(bv,task_id,dl_path,sub_dir):
    def _hook(d):
        s=d.get("status")
        if s=="downloading":
            total=d.get("total_bytes") or d.get("total_bytes_estimate",0)
            done=d.get("downloaded_bytes",0)
            pct=round(done/total*100,1) if total else 0
            _task_set(task_id,status="downloading",progress=pct,speed=_fmt_speed(d.get("speed")),eta=_fmt_eta(d.get("eta")),downloaded_bytes=done,total_bytes=total)
        elif s=="finished":
            _task_set(task_id,status="merging",progress=100)

    opts={
        "format":"bv*[height<=1080]+ba/b[height<=1080]",
        "format_sort":["vcodec:avc1"],  # 优先 H.264，避免下载 AV1 编码（部分播放器不支持）
        "outtmpl":str(Path(dl_path)/sub_dir/"%(title)s.%(ext)s"),
        "merge_output_format":"mp4",
        "restrictfilenames":True,
        "noplaylist":True,
        "quiet":True,
        "no_warnings":True,
        "progress_hooks":[_hook],
    }
    if FFMPEG_PATH:
        opts["ffmpeg_location"]=FFMPEG_PATH

    try:
        _task_set(task_id,status="fetching",progress=0)
        with yt_dlp.YoutubeDL(opts) as ydl:
            info=ydl.extract_info(f"https://www.bilibili.com/video/{bv}",download=True)
            _task_set(task_id,status="completed",title=info.get("title",""),progress=100)
    except Exception as e:
        _task_set(task_id,status="error",error=str(e)[:200])

def _fmt_speed(s):
    if not s: return ""
    if s>=1024*1024: return f"{s/1024/1024:.1f} MB/s"
    if s>=1024: return f"{s/1024:.1f} KB/s"
    return f"{s:.0f} B/s"

def _fmt_eta(e):
    if not e or e<=0: return ""
    if e>3600: return f"{e//3600}h{(e%3600)//60}m"
    if e>60: return f"{e//60}m{e%60}s"
    return f"{e}s"

def _main():
    _load_config()
    DEFAULT_DOWNLOADS.mkdir(exist_ok=True)
    webbrowser.open("http://127.0.0.1:5000")
    app.run(host="127.0.0.1",port=5000,debug=False,threaded=True)

if __name__=="__main__":
    _main()
