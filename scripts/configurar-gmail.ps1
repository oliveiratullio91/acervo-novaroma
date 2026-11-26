Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$janela = New-Object Windows.Forms.Form
$janela.Text = 'Acervo | Conectar Gmail'
$janela.ClientSize = New-Object Drawing.Size(460,315)
$janela.StartPosition = 'CenterScreen'
$janela.FormBorderStyle = 'FixedDialog'
$janela.MaximizeBox = $false
$janela.TopMost = $true
$janela.Font = New-Object Drawing.Font('Segoe UI',10)

function Rotulo([string]$texto, [int]$y) {
    $rotulo = New-Object Windows.Forms.Label
    $rotulo.Text = $texto
    $rotulo.SetBounds(20,$y,420,24)
    $janela.Controls.Add($rotulo)
}
Rotulo 'Conectar o remetente da Biblioteca Acervo ao Gmail' 14
Rotulo 'E-mail completo da conta Google' 54
$email = New-Object Windows.Forms.TextBox
$email.SetBounds(20,80,420,28)
$janela.Controls.Add($email)
Rotulo 'Senha de app gerada pelo Google (16 caracteres)' 119
$senha = New-Object Windows.Forms.TextBox
$senha.UseSystemPasswordChar = $true
$senha.SetBounds(20,146,420,28)
$janela.Controls.Add($senha)
$ajuda = New-Object Windows.Forms.LinkLabel
$ajuda.Text = 'Abrir Senhas de app na Conta do Google'
$ajuda.SetBounds(20,184,412,25)
$ajuda.Add_LinkClicked({ [Diagnostics.Process]::Start([Diagnostics.ProcessStartInfo]@{FileName='https://myaccount.google.com/apppasswords'; UseShellExecute=$true}) | Out-Null })
$janela.Controls.Add($ajuda)
$estado = New-Object Windows.Forms.Label
$estado.SetBounds(20,216,420,45)
$estado.Text = 'O Acervo verifica a conexão antes de salvar no arquivo privado do projeto.'
$janela.Controls.Add($estado)
$salvar = New-Object Windows.Forms.Button
$salvar.Text = 'Conectar Gmail'
$salvar.SetBounds(290,270,150,32)
$janela.AcceptButton = $salvar
$janela.Controls.Add($salvar)
$salvar.Add_Click({
    $endereco = $email.Text.Trim()
    $chave = $senha.Text -replace '\s',''
    if ($endereco -notmatch '^[^\s@]+@[^\s@]+\.[^\s@]+$' -or $chave -notmatch '^[a-zA-Z0-9]{16}$') {
        $estado.Text = 'Confira o endereço e os 16 caracteres da senha de app.'
        return
    }
    $salvar.Enabled = $false
    $estado.Text = 'Verificando a autenticação no Gmail...'
    $janela.Refresh()
    try {
        $inicio = New-Object Diagnostics.ProcessStartInfo
        $inicio.FileName = (Get-Command node -CommandType Application | Select-Object -First 1).Source
        $inicio.WorkingDirectory = Split-Path -Parent $PSScriptRoot
        $inicio.Arguments = 'scripts/verificar-email.js --salvar'
        $inicio.UseShellExecute = $false
        $inicio.CreateNoWindow = $true
        $inicio.RedirectStandardError = $true
        $inicio.EnvironmentVariables['GMAIL_USUARIO'] = $endereco
        $inicio.EnvironmentVariables['GMAIL_SENHA_APP'] = $chave
        $verificacao = [Diagnostics.Process]::Start($inicio)
        $falha = $verificacao.StandardError.ReadToEnd()
        $verificacao.WaitForExit()
        if ($verificacao.ExitCode -eq 0) {
            $senha.Clear()
            [Windows.Forms.MessageBox]::Show($janela,'O Gmail autenticou o remetente. A configuração foi salva no projeto.','Biblioteca Acervo') | Out-Null
            $janela.Close()
        } else { $estado.Text = $falha.Trim() }
    } catch { $estado.Text = 'Falha ao abrir o verificador de e-mail do Acervo.' }
    finally { $salvar.Enabled = $true; $chave = $null }
})
$janela.Add_Shown({ $janela.Activate(); $janela.TopMost = $false })
$null = $janela.ShowDialog()
$senha.Clear()
$janela.Dispose()
