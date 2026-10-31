param(
    [string]$TargetUrl = "http://127.0.0.1:8080",
    [string]$ApiKey = "O2P-54ce9d315cbf95864a41accc5e2fc69e",
    [string]$Model = "big-pickle"
)

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " OpenCode2API v3.1.0 Chat Completion Verification" -ForegroundColor Cyan
Write-Host " Endpoint : $TargetUrl/v1/chat/completions" -ForegroundColor Gray
Write-Host " Model    : $Model" -ForegroundColor Gray
Write-Host "============================================================" -ForegroundColor Cyan

$payload = @{
    model = $Model
    messages = @(
        @{ role = "user"; content = "Respond with: Hello from OpenCode2API v3.1.0!" }
    )
    max_tokens = 60
} | ConvertTo-Json -Depth 5

$headers = @{
    "Authorization" = "Bearer $ApiKey"
    "Content-Type"  = "application/json"
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $response = Invoke-RestMethod -Uri "$TargetUrl/v1/chat/completions" -Method Post -Headers $headers -Body $payload
    $sw.Stop()
    $elapsed = [math]::Round($sw.Elapsed.TotalSeconds, 2)

    Write-Host "`n[HTTP 200 OK] Response in ${elapsed}s" -ForegroundColor Green
    Write-Host "Model ID   : $($response.model)" -ForegroundColor Yellow
    Write-Host "Tokens     : Total $($response.usage.total_tokens) (Prompt $($response.usage.prompt_tokens) + Completion $($response.usage.completion_tokens))" -ForegroundColor Gray
    Write-Host "`nAssistant Output:" -ForegroundColor White
    Write-Host "------------------------------------------------------------" -ForegroundColor DarkGray
    Write-Host $response.choices[0].message.content -ForegroundColor White
    if ($response.choices[0].message.reasoning_content) {
        Write-Host "`nReasoning Trace:" -ForegroundColor Magenta
        Write-Host $response.choices[0].message.reasoning_content -ForegroundColor DarkGray
    }
    Write-Host "------------------------------------------------------------" -ForegroundColor DarkGray
} catch {
    $sw.Stop()
    $elapsed = [math]::Round($sw.Elapsed.TotalSeconds, 2)
    Write-Host "`n[ERROR] Request failed in ${elapsed}s: $_" -ForegroundColor Red
}
