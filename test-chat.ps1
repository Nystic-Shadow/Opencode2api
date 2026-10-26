# PowerShell Synchronous Test for OpenCode2API (OpenAI & Anthropic)
# Usage: .\test-chat.ps1 [-Target Local|Prod] [-Model <model-name>] [-Format OpenAI|Anthropic]

param (
    [ValidateSet("Local", "Prod")]
    [string]$Target = "Local",
    [string]$Model = "glm-5.3-flash",
    [ValidateSet("OpenAI", "Anthropic")]
    [string]$Format = "OpenAI",
    [string]$Prompt = "Say 'OpenCode2API Verified' in exactly 3 words."
)

if ($Target -eq "Local") {
    $BaseUrl = "http://127.0.0.1:8080"
    $ApiKey  = "O2P-54ce9d315cbf95864a41accc5e2fc69e"
} else {
    $BaseUrl = "https://opencode.nysticshadow.qzz.io"
    $ApiKey  = "O2P-ea27b9ec315fa8bf630840ffa31dcfc1"
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "  OpenCode2API Sync Verification ($Format)" -ForegroundColor Cyan
Write-Host "  Target: $Target ($BaseUrl)" -ForegroundColor Yellow
Write-Host "  Model:  $Model" -ForegroundColor Yellow
Write-Host "==========================================================`n" -ForegroundColor Cyan

if ($Format -eq "OpenAI") {
    $body = @{
        model = $Model
        messages = @(
            @{ role = "user"; content = $Prompt }
        )
        max_tokens = 50
    } | ConvertTo-Json

    $res = Invoke-RestMethod -Uri "$BaseUrl/v1/chat/completions" `
        -Method Post `
        -Headers @{
            "Authorization" = "Bearer $ApiKey"
            "Content-Type"  = "application/json"
        } `
        -Body $body

    Write-Host "[Response content]:" -ForegroundColor White
    $content = $res.choices[0].message.content
    if ($content) {
        Write-Host $content -ForegroundColor Green
    } else {
        Write-Host $res.choices[0].message.reasoning_content -ForegroundColor DarkGray
    }
} else {
    $body = @{
        model = $Model
        messages = @(
            @{ role = "user"; content = $Prompt }
        )
        max_tokens = 50
    } | ConvertTo-Json

    $res = Invoke-RestMethod -Uri "$BaseUrl/v1/messages" `
        -Method Post `
        -Headers @{
            "x-api-key"          = $ApiKey
            "anthropic-version"  = "2023-06-01"
            "Content-Type"       = "application/json"
        } `
        -Body $body

    Write-Host "[Response text]:" -ForegroundColor White
    Write-Host $res.content[0].text -ForegroundColor Green
}

Write-Host "`n[Finished successfully]" -ForegroundColor Cyan
