; 安装后不启动普通权限进程，用户点击完成，再从桌面以管理员身份打开。
!macro customFinishPage
  !define MUI_FINISHPAGE_TITLE "安装完成"
  !define MUI_FINISHPAGE_TEXT "监考客户端已安装。$\r$\n$\r$\n请点击【完成】，然后在桌面右键监考客户端，选择【以管理员身份运行】。$\r$\n$\r$\n监考日志、设备身份和更新缓存保存在安装目录的 data 文件夹。"
  !insertmacro MUI_PAGE_FINISH
!macroend

; 覆盖默认 RMDir /r，更新/卸载时保留 data 下尚未上传的监考证据。
; 安装器始终创建独立产品子目录，data 是唯一运行数据目录。
!macro customRemoveFiles
  SetOutPath $TEMP
  ; 沿用 builder 的原子搬迁与回滚，先确认程序文件可移除，再删除目录。
  ; data 从一开始就不参与搬迁，升级失败也不会影响监考证据。
  CreateDirectory "$PLUGINSDIR\old-install"
  FindFirst $R0 $R1 "$INSTDIR\*.*"
  ${DoWhile} $R1 != ""
    ${If} $R1 != "."
    ${AndIf} $R1 != ".."
    ${AndIf} $R1 != "data"
      StrCpy $R2 "0"
      ${If} ${FileExists} "$INSTDIR\$R1\*.*"
        CreateDirectory "$PLUGINSDIR\old-install\$R1"
        Push "\$R1"
        Call un.atomicRMDir
        Pop $R2
      ${Else}
        ClearErrors
        Rename "$INSTDIR\$R1" "$PLUGINSDIR\old-install\$R1"
        StrCmp $R1 "${UNINSTALL_FILENAME}" 0 +2
          ClearErrors
        IfErrors 0 +2
          StrCpy $R2 "$INSTDIR\$R1"
      ${EndIf}
      ${If} $R2 != "0"
        FindClose $R0
        DetailPrint "File is busy, aborting: $R2"
        Push ""
        Call un.restoreFiles
        Pop $R2
        Abort "无法移除正在使用的程序文件，请关闭监考客户端后重试。监考数据已保留。"
      ${EndIf}
    ${EndIf}
    FindNext $R0 $R1
  ${Loop}
  FindClose $R0
  FindFirst $R0 $R1 "$INSTDIR\*.*"
  ${DoWhile} $R1 != ""
    ${If} $R1 != "."
    ${AndIf} $R1 != ".."
    ${AndIf} $R1 != "data"
      IfFileExists "$INSTDIR\$R1\*.*" 0 +3
        RMDir /r "$INSTDIR\$R1"
        Goto +2
      Delete "$INSTDIR\$R1"
    ${EndIf}
    FindNext $R0 $R1
  ${Loop}
  FindClose $R0
  RMDir "$INSTDIR"
!macroend
