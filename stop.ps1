Set-Location $PSScriptRoot;docker compose stop atlas;if($LASTEXITCODE -ne 0){throw 'Stop failed'};Write-Host 'Stopped. Persistent data retained.'
