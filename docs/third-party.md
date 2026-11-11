# Third-party notices

- Foxdown continues development from [Rdown](https://github.com/aimaonews/Rdown). Its MIT license and original copyright notice are preserved in [LICENSE](../LICENSE).
- aria2 is a separate executable. Foxdown prepares the platform binary during its build from the [pinned Motrix tree](https://github.com/agalwood/Motrix/tree/a0a1fe90f7e9f6d305ed2b512f62c8d36c2fb95a/extra) and checks its SHA-256. See [aria2’s license and source](https://github.com/aria2/aria2).
- Windows FFmpeg and FFprobe are bundled from the [ffmpeg-static b6.1.1 release](https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1). Their platform license and source notes are included in the engine directory.
- macOS FFmpeg and FFprobe come from [ffmpeg-macos-builds 9.0.1-1, LGPL variant](https://github.com/dfloresc/ffmpeg-macos-builds/releases/tag/v9.0.1-1). The package includes shared libraries, component notices, exact configuration and source checksums in `media/LICENSES` and `media/BUILDINFO.txt`. [Corresponding source archives](https://github.com/dfloresc/ffmpeg-macos-builds/releases/tag/v9.0.1-1) · [FFmpeg licensing](https://ffmpeg.org/legal.html).
- The optional external [N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE) engine is installed by the user.
- The extension includes hls.js under the terms in [extension/vendor/hls.LICENSE](../extension/vendor/hls.LICENSE). [hls.js source](https://github.com/video-dev/hls.js)

See the [reference project table](../README.md#reference-projects) for the projects that informed Foxdown’s design and behavior.
