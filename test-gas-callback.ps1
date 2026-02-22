# ─────────────────────────────────────────────────────────────────────────────
# test-gas-callback.ps1  —  Bot → GAS doPost 엔드포인트 테스트
# 사용법: .\test-gas-callback.ps1 -GasUrl "https://script.google.com/macros/s/.../exec"
#         .\test-gas-callback.ps1 -GasUrl $env:GAS_WEB_APP_URL -Action REJECTED
#
# Action 값: ACCEPTED | REJECTED | IN_PROGRESS | DONE
# ─────────────────────────────────────────────────────────────────────────────

param(
    [Parameter(Mandatory = $true)]
    [string]$GasUrl,

    [string]$Action         = "ACCEPTED",
    [string]$RowId          = "T-20260222-001",
    [string]$ActorUserId    = "1270201123218784312",   # 테스트 유저 ID
    [string]$RejectReason   = "일정 충돌로 인해 불가합니다",
    [string]$DoneNote       = "번역 완료. QA 검토 요청드립니다."
)

# action에 따라 추가 필드 포함
$Payload = @{
    row_id                = $RowId
    action                = $Action
    actor_discord_user_id = $ActorUserId
}

if ($Action -eq "REJECTED") {
    $Payload["reject_reason"] = $RejectReason
}
if ($Action -eq "DONE") {
    $Payload["done_note"] = $DoneNote
}

$JsonBody = $Payload | ConvertTo-Json -Depth 5 -Compress
$Bytes    = [System.Text.Encoding]::UTF8.GetBytes($JsonBody)

Write-Host ""
Write-Host "▶  POST (GAS doPost)" -ForegroundColor Cyan
Write-Host "   URL     : $GasUrl"
Write-Host "   action  : $Action"
Write-Host "   row_id  : $RowId"
Write-Host "   payload : $JsonBody"
Write-Host ""

try {
    # GAS 웹앱은 302 리다이렉트를 반환할 수 있으므로 -MaximumRedirection 5 필요
    $Response = Invoke-RestMethod `
        -Method             POST `
        -Uri                $GasUrl `
        -ContentType        "application/json; charset=utf-8" `
        -Body               $Bytes `
        -MaximumRedirection 5 `
        -ErrorAction        Stop

    if ($Response.ok -eq $true) {
        Write-Host "✅ GAS doPost 성공" -ForegroundColor Green
        Write-Host "   row_id : $($Response.row_id)"
        Write-Host "   action : $($Response.action)"
    } else {
        Write-Host "⚠️  GAS 오류: $($Response.error)" -ForegroundColor Yellow
    }
}
catch {
    Write-Host "❌ 요청 실패: $_" -ForegroundColor Red
    if ($_.Exception.Response) {
        $Stream = $_.Exception.Response.GetResponseStream()
        $Reader = New-Object System.IO.StreamReader($Stream)
        Write-Host "   응답 본문: " $Reader.ReadToEnd()
    }
}

Write-Host ""
Write-Host "각 Action별 테스트 예시:" -ForegroundColor DarkGray
Write-Host '  .\test-gas-callback.ps1 -GasUrl $env:GAS_WEB_APP_URL -Action ACCEPTED'
Write-Host '  .\test-gas-callback.ps1 -GasUrl $env:GAS_WEB_APP_URL -Action REJECTED'
Write-Host '  .\test-gas-callback.ps1 -GasUrl $env:GAS_WEB_APP_URL -Action IN_PROGRESS'
Write-Host '  .\test-gas-callback.ps1 -GasUrl $env:GAS_WEB_APP_URL -Action DONE'
