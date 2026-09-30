' Shortcut entry for LittleSheep: run the launcher without a console window.
'
' `pwsh -WindowStyle Hidden` is not enough on a Windows 11 machine whose default terminal
' application is Windows Terminal. The console host is a separate GUI process
' (`WindowsTerminal`), it opens a visible window for the console anyway, and a launcher waiting
' inside that console dies with it the moment the window is closed, which reads as "the icon
' opens a command window and LittleSheep never starts". Windows Script Host starts the same
' PowerShell with a hidden window and owns no console itself, so the click is silent.
'
' Nothing else moves: the fail-closed build gate, the newest prepared runtime, the start of the
' app itself and its log live in scripts/launch-littlesheep.ps1.
Option Explicit

Dim fileSystem, shell, scriptDirectory, launcherPath, powerShellPath, commandLine

Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
launcherPath = fileSystem.BuildPath(scriptDirectory, "launch-littlesheep.ps1")
If Not fileSystem.FileExists(launcherPath) Then
  MsgBox "The LittleSheep launcher is missing:" & vbCrLf & vbCrLf & launcherPath, 16, "LittleSheep"
  WScript.Quit 2
End If

' The launcher is written for PowerShell 7 but stays 5.1-compatible, so the Windows PowerShell
' that every Windows installs is an acceptable fallback.
powerShellPath = fileSystem.BuildPath(shell.ExpandEnvironmentStrings("%ProgramFiles%"), "PowerShell\7\pwsh.exe")
If Not fileSystem.FileExists(powerShellPath) Then
  powerShellPath = fileSystem.BuildPath(shell.ExpandEnvironmentStrings("%SystemRoot%"), "System32\WindowsPowerShell\v1.0\powershell.exe")
End If
If Not fileSystem.FileExists(powerShellPath) Then
  MsgBox "PowerShell was not found, so LittleSheep cannot start.", 16, "LittleSheep"
  WScript.Quit 3
End If

commandLine = """" & powerShellPath & """ -NoProfile -ExecutionPolicy Bypass -File """ & launcherPath & """"

' 0 = hidden window, False = do not wait: the launcher owns the application's lifetime.
shell.Run commandLine, 0, False
