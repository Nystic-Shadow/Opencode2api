param(
    [string]$TargetUrl = "http://127.0.0.1:8080",
    [string]$ApiKey = "O2P-54ce9d315cbf95864a41accc5e2fc69e",
    [string]$Model = "glm-5.3-flash",
    [string]$Prompt = "Write a haiku about high-speed AI gateways."
)

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host " OpenCode2API v3.0.0 Real-Time SSE Streaming Verification" -ForegroundColor Cyan
Write-Host " Endpoint : $TargetUrl/v1/chat/completions" -ForegroundColor Gray
Write-Host " Model    : $Model" -ForegroundColor Gray
Write-Host " Prompt   : $Prompt" -ForegroundColor Gray
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Connecting and streaming tokens..." -ForegroundColor Gray

Add-Type -AssemblyName System.Net.Http

$handler = [System.Net.Http.HttpClientHandler]::new()
$client = [System.Net.Http.HttpClient]::new($handler)
$client.Timeout = [TimeSpan]::FromSeconds(60)

$payload = @{
    model = $Model
    messages = @(
        @{ role = "user"; content = $Prompt }
    )
    stream = $true
    max_tokens = 150
} | ConvertTo-Json -Depth 5

$request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, "$TargetUrl/v1/chat/completions")
$request.Headers.Add("Authorization", "Bearer $ApiKey")
$request.Content = [System.Net.Http.StringContent]::new($payload, [System.Text.Encoding]::UTF8, "application/json")

$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
    $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) {
        $errorBody = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        Write-Host "`n[ERROR HTTP $($response.StatusCode)]: $errorBody" -ForegroundColor Red
        return
    }

    $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8)

    Write-Host "`n--- Live Stream Output ---" -ForegroundColor Yellow
    $tokenCount = 0
    $firstTokenTime = $null

    while (-not $reader.EndOfStream) {
        $line = $reader.ReadLine()
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -eq "data: [DONE]") { break }
        if ($line.StartsWith("data: ")) {
            $jsonStr = $line.Substring(6).Trim()
            try {
                $chunk = $jsonStr | ConvertFrom-Json
                $delta = $chunk.choices[0].delta
                if ($delta.content) {
                    if ($null -eq $firstTokenTime) { $firstTokenTime = $sw.Elapsed.TotalSeconds }
                    [System.Console]::Write($delta.content)
                    $tokenCount++
                }
            } catch {}
        }
    }
    $sw.Stop()
    $totalTime = [math]::Round($sw.Elapsed.TotalSeconds, 2)
    $ttft = if ($null -ne $firstTokenTime) { [math]::Round($firstTokenTime, 2) } else { 0 }
    $tps = if ($totalTime -gt 0 -and $tokenCount -gt 0) { [math]::Round($tokenCount / $totalTime, 1) } else { 0 }

    Write-Host "`n------------------------------------------------------------" -ForegroundColor DarkGray
    Write-Host "[SUCCESS] Stream complete!" -ForegroundColor Green
    Write-Host "Total Time : ${totalTime}s | Time-To-First-Token: ${ttft}s | Velocity: $tps tok/s" -ForegroundColor Gray
} catch {
    Write-Host "`n[ERROR] Stream failed: $_" -ForegroundColor Red
} finally {
    $client.Dispose()
    $handler.Dispose()
}
