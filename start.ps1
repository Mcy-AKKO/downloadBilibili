Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Bilibili Video Downloader" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Server: http://127.0.0.1:5000" -ForegroundColor Green
Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray
Write-Host ""

$python = "C:\Users\24097\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"

if (Test-Path $python) {
    & $python "D:\视频下载\main.py"
} else {
    try { python "D:\视频下载\main.py" }
    catch {
        Write-Host "Python not found!" -ForegroundColor Red
        Read-Host "Press Enter to exit"
    }
}
