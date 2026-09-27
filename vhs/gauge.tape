# VHS tape for pi-gauge demo GIF.
# Renders vhs/demo.mjs (which imports the REAL renderText from dist/)
# into assets/demo.gif for the README.
# Docs: https://github.com/charmbracelet/vhs

Output assets/demo.gif

Set Shell "zsh"
Set FontFamily "BlexMono Nerd Font Mono"
Set FontSize 15
Set Width 980
Set Height 640
Set Padding 16
Set LineHeight 1.2
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set Framerate 30
Set PlaybackSpeed 1

# Type the command hidden, then show only its output.
Hide
Type "node vhs/demo.mjs" Enter
Show
Sleep 17s
