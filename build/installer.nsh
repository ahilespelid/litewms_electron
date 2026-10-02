; После установки оболочки тихо ставим Device Agent (для печати на принтеры).
; Установщик агента ставит себя в профиль пользователя и прописывает автозапуск.
!macro customInstall
  IfFileExists "$INSTDIR\resources\agent\LiteWMS.DeviceAgent-Setup.exe" 0 +4
    DetailPrint "Установка LiteWMS Device Agent..."
    ExecWait '"$INSTDIR\resources\agent\LiteWMS.DeviceAgent-Setup.exe" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART'
    ; тихая установка не запускает агент сама
    IfFileExists "$LOCALAPPDATA\Programs\LiteWMS\DeviceAgent\LiteWMS.DeviceAgent.exe" 0 +2
      Exec '"$LOCALAPPDATA\Programs\LiteWMS\DeviceAgent\LiteWMS.DeviceAgent.exe"'
!macroend
