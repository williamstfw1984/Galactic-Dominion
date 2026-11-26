; Stop this program's private AI engine (and the model process it started) and its voice engine before files are
; removed, so the uninstaller can delete everything. A separately installed Ollama is not touched.
!macro customUnInit
  nsExec::Exec 'taskkill /F /T /IM galactic-dominion-engine.exe'
  nsExec::Exec 'taskkill /F /T /IM galactic-dominion-voice.exe'
!macroend

; The installer keeps a copy of itself in this folder at install time, and the standard
; uninstaller leaves it behind. Remove it on a real uninstall (not during an upgrade).
!macro customUnInstall
  ${ifNot} ${isUpdated}
    RMDir /r "$LOCALAPPDATA\galactic-dominion-updater"
  ${endIf}
!macroend

; An installer carries its settings after its own data (see settings-format.js):
; <settings text> <"1" and the 9-digit length of that text> <RPSETTINGS>. Put them where the program looks for settings
; that are to replace its own.
!macro customInstall
  FileOpen $0 "$EXEPATH" r
  FileSeek $0 -20 END
  FileRead $0 $1 10
  FileRead $0 $2 10
  ${If} $2 == "RPSETTINGS"
    IntOp $1 $1 - 1000000000
    IntOp $3 $1 + 20
    FileSeek $0 -$3 END
    FileOpen $4 "$INSTDIR\resources\installer-settings.dat" w
    ${While} $1 > 0
      StrCpy $5 $1
      ${If} $5 > 1000
        StrCpy $5 1000
      ${EndIf}
      FileRead $0 $6 $5
      FileWrite $4 $6
      IntOp $1 $1 - $5
    ${EndWhile}
    FileClose $4
  ${EndIf}
  FileClose $0
!macroend
