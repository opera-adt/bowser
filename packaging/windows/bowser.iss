; Inno Setup script: Bowser-<version>-windows-x64-setup.exe from PyInstaller's dist\Bowser folder.
;   iscc /DAppVersion=1.2.3 packaging\windows\bowser.iss
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppName=Bowser
AppVersion={#AppVersion}
AppPublisher=OPERA ADT
DefaultDirName={autopf}\Bowser
DefaultGroupName=Bowser
OutputDir=..\..\release
OutputBaseFilename=Bowser-{#AppVersion}-windows-x64-setup
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=lowest
Compression=lzma2
SolidCompression=yes
WizardStyle=modern

[Files]
Source: "..\..\dist\Bowser\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{group}\Bowser"; Filename: "{app}\Bowser.exe"
Name: "{autodesktop}\Bowser"; Filename: "{app}\Bowser.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Run]
Filename: "{app}\Bowser.exe"; Description: "Start Bowser"; Flags: nowait postinstall skipifsilent
