# ─────────────────────────────────────────────────────────────────────────────
# test-webhook.ps1  —  /webhook 엔드포인트 로컬 테스트 스크립트
# 사용법: PowerShell에서  .\test-webhook.ps1
#
# 주의: discord_user_id를 실제 18자리 Discord User ID로 교체하세요.
#       개발자 모드 활성화 → Discord에서 사용자 우클릭 → "ID 복사"
# ─────────────────────────────────────────────────────────────────────────────

param(
    [string]$Port   = "3000",
    [string]$Stage  = "ACK"         # "ACK" | "PROGRESS" | "DONE"
)

$Url = "http://localhost:$Port/webhook"

# ── 테스트 페이로드 ────────────────────────────────────────────────────────────
$Payload = @{
    row_id             = "T-20260222-001"
    discord_user_id    = "000000000000000000"   # ← 실제 Discord User ID (18자리)로 교체
    assignee_real_name = "홍길동"
    project            = "라이선스 SUNDAY #65"
    language           = "한국어"
    file_link          = "https://drive.google.com/file/d/EXAMPLE"
    pm_real_name       = "이수민"
    stage              = $Stage
}

$JsonBody = $Payload | ConvertTo-Json -Depth 5 -Compress
$Bytes    = [System.Text.Encoding]::UTF8.GetBytes($JsonBody)

Write-Host ""
Write-Host "▶  POST $Url" -ForegroundColor Cyan
Write-Host "   Stage : $Stage"
Write-Host "   Body  : $JsonBody"
Write-Host ""

try {
    $Response = Invoke-RestMethod `
        -Method      POST `
        -Uri         $Url `
        -ContentType "application/json; charset=utf-8" `
        -Body        $Bytes `
        -ErrorAction Stop

    Write-Host "✅ 응답:" -ForegroundColor Green
    $Response | ConvertTo-Json | Write-Host
}
catch {
    Write-Host "❌ 오류: $_" -ForegroundColor Red
    if ($_.Exception.Response) {
        $Stream = $_.Exception.Response.GetResponseStream()
        $Reader = New-Object System.IO.StreamReader($Stream)
        Write-Host "   응답 본문: " $Reader.ReadToEnd()
    }
}

Write-Host ""

# ── healthz 확인 ──────────────────────────────────────────────────────────────
Write-Host "── /healthz 확인 ──────────────────────────────────" -ForegroundColor DarkGray
try {
    $Health = Invoke-RestMethod -Method GET -Uri "http://localhost:$Port/healthz" -ErrorAction Stop
    Write-Host "   상태: OK  ts=$($Health.ts)" -ForegroundColor Green
}
catch {
    Write-Host "   /healthz 응답 없음 (봇이 실행 중인지 확인하세요)" -ForegroundColor Yellow
}
