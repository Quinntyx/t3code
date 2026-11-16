// mkdmg wraps a packaged .app in a styled macOS disk image without hdiutil,
// for desktop builds packaged on a host that is not macOS.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/leaanthony/dmg/dmg"
)

func main() {
	app := flag.String("app", "", "path to the .app bundle")
	out := flag.String("out", "", "path to the output .dmg")
	volume := flag.String("volume", "", "volume name shown in Finder (default: the app's name)")
	background := flag.String("background", "", "Finder window background image")
	flag.Parse()

	if *app == "" || *out == "" {
		fmt.Fprintln(os.Stderr, "usage: mkdmg -app <Name.app> -out <Name.dmg> [-volume name] [-background image]")
		os.Exit(2)
	}

	appName := filepath.Base(*app)
	if *volume == "" {
		*volume = strings.TrimSuffix(appName, ".app")
	}
	// The window and icon layout mirrors the dmg block in scripts/build-desktop-artifact.ts,
	// which the background artwork is drawn for.
	opts := dmg.Options{
		VolumeName:             *volume,
		OutputPath:             *out,
		Files:                  map[string]string{appName: *app},
		AddApplicationsSymlink: true,
		Window:                 dmg.WindowConfig{X: 400, Y: 100, Width: 640, Height: 432},
		Icon:                   dmg.IconConfig{Size: 120, TextSize: 12, GridSpace: 100},
		IconPositions: map[string]dmg.IconPosition{
			appName:        {X: 166, Y: 214},
			"Applications": {X: 474, Y: 214},
		},
		Backend: dmg.BackendNative,
	}
	if *background != "" {
		opts.Background = &dmg.BackgroundConfig{File: *background}
	}

	if err := dmg.Build(opts); err != nil {
		fmt.Fprintf(os.Stderr, "mkdmg: %v\n", err)
		os.Exit(1)
	}
}
