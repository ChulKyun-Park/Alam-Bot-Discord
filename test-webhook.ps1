# ─────────────────────────────────────────────────────────────────────────────
# test-webhook.ps1  —  GAS → Bot /webhook 엔드포인트 로컬 테스트
# 사용법: .\test-webhook.ps1 [-Port 3000] [-Stage ACK]
#
# Stage 값: ACK | PROGRESS | DONE
# ─────────────────────────────────────────────────────────────────────────────

param(
    [string]$Port           = "3000",
    [string]$Stage          = "ACK",
    [string]$DiscordUserId  = "1270201123218784312",   # 테스트 유저 ID
    [string]$RowId          = "T-20260222-001"
)

$Url = "http://localhost:$Port/webhook"

$Payload = @{
    row_id             = $RowId
    discord_user_id    = $DiscordUserId
    assignee_real_name = "테스트 담당자"
    project            = "라이선스 SUNDAY #65"
    language           = "한국어"
    file_link          = "https://drive.google.com/file/d/TEST_FILE_ID"
    pm_real_name       = "이수민"
    stage              = $Stage
} | ConvertTo-Json -Depth 5 -Compress

$Bytes = [System.Text.Encoding]::UTF8.GetBytes($Payload)

Write-Host ""
Write-Host "▶  POST $Url" -ForegroundColor Cyan
Write-Host "   row_id  : $RowId"
Write-Host "   user_id : $DiscordUserId"
Write-Host "   stage   : $Stage"
Write-Host ""

try {
    $Response = Invoke-RestMethod `
        -Method      POST `
        -Uri         $Url `
        -ContentType "application/json; charset=utf-8" `
        -Body        $Bytes `
        -ErrorAction Stop

    if ($Response.ok -eq $true) {
        Write-Host "✅ 성공" -ForegroundColor Green
    } else {
        Write-Host "⚠️  서버 오류: $($Response.error)" -ForegroundColor Yellow
    }
    $Response | ConvertTo-Json | Write-Host
}
catch {
    Write-Host "❌ 요청 실패: $_" -ForegroundColor Red
}

Write-Host ""
Write-Host "── /healthz 확인 ───────────────────────────────────" -ForegroundColor DarkGray
try {
    $Health = Invoke-RestMethod -Method GET -Uri "http://localhost:$Port/healthz" -ErrorAction Stop
    Write-Host "   ✅ 봇 실행 중  ts=$($Health.ts)" -ForegroundColor Green
}
catch {
    Write-Host "   ❌ /healthz 응답 없음 — 봇이 실행 중인지 확인하세요." -ForegroundColor Red
}
