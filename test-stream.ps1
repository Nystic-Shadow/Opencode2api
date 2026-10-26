# PowerShell Real-time Streaming Test for OpenCode2API
# Usage: .\test-stream.ps1 [-Target Local|Prod] [-Model <model-name>] [-Prompt <prompt>]

param (
    [ValidateSet("Local", "Prod")]
    [string]$Target = "Local",
    [string]$Model = "glm-5.3-flash",
    [string]$Prompt = "Explain recursion in 2 short sentences."
)

Add-Type -AssemblyName System.Net.Http

if ($Target -eq "Local") {
    $BaseUrl = "http://127.0.0.1:8080"
    $ApiKey  = "O2P-54ce9d315cbf95864a41accc5e2fc69e"
} else {
    $BaseUrl = "https://opencode.nysticshadow.qzz.io"
    $ApiKey  = "O2P-ea27b9ec315fa8bf630840ffa31dcfc1"
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  OpenCode2API Real-time Streaming Client" -ForegroundColor Cyan
Write-Host "  Target: $Target ($BaseUrl)" -ForegroundColor Yellow
Write-Host "  Model:  $Model" -ForegroundColor Yellow
Write-Host "==========================================================`n" -ForegroundColor Cyan

$client = [System.Net.Http.HttpClient]::new()
$client.DefaultRequestHeaders.Add("Authorization", "Bearer $ApiKey")

$payload = @{
    model = $Model
    messages = @(
        @{ role = "user"; content = $Prompt }
    )
    stream = $true
    max_tokens = 150
} | ConvertTo-Json -Compress

$content = [System.Net.Http.StringContent]::new($payload, [System.Text.Encoding]::UTF8, "application/json")

try {
    $response = $client.PostAsync("$BaseUrl/v1/chat/completions", $content).GetAwaiter().GetResult()

    if (-not $response.IsSuccessStatusCode) {
        $err = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        Write-Error "HTTP $([int]$response.StatusCode): $err"
        return
    }

    $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $reader = [System.IO.StreamReader]::new($stream)

    Write-Host "[Streaming Output]:" -ForegroundColor White

    while (-not $reader.EndOfStream) {
        $line = $reader.ReadLine()
        if ($line.StartsWith("data: ")) {
            $jsonStr = $line.Substring(6).Trim()
            if ($jsonStr -eq "[DONE]") { break }
            try {
                $chunk = $jsonStr | ConvertFrom-Json
                $delta = $chunk.choices[0].delta
                if ($delta.reasoning_content) {
                    Write-Host -NoNewline $delta.reasoning_content -ForegroundColor DarkGray
                }
                if ($delta.content) {
                    Write-Host -NoNewline $delta.content -ForegroundColor Green
                }
            } catch {}
        }
    }
    Write-Host "`n`n[Finished successfully]" -ForegroundColor Cyan
} finally {
    $client.Dispose()
}
