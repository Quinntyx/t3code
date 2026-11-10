import AVFoundation
import ExpoModulesCore
import UIKit

public final class T3VoiceAudioModule: Module {
  private let lock = NSRecursiveLock()
  private var current: Session?
  private var observers: [NSObjectProtocol] = []

  private final class Session {
    let id: Int
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    var epoch = 0
    var muted = false
    var terminal = false
    var inFlight = false
    var input: [Data] = []
    var frame = Data()
    var outputSamples = 0
    var converter: AVAudioConverter?
    var tapInstalled = false
    init(_ id: Int) { self.id = id }
  }

  public func definition() -> ModuleDefinition {
    Name("T3VoiceAudio")
    Events("voiceEvent")
    AsyncFunction("start") { (id: Int) in try self.start(id) }.runOnQueue(.main)
    Function("stop") { (id: Int) in self.stop(id) }
    Function("mute") { (id: Int, muted: Bool) in
      self.lock.lock(); defer { self.lock.unlock() }
      guard let s = self.current, s.id == id else { return }
      s.muted = muted; s.input.removeAll(); s.frame.removeAll(keepingCapacity: true); s.converter?.reset()
    }
    Function("acknowledge") { (id: Int) in
      self.lock.lock(); defer { self.lock.unlock() }
      guard let s = self.current, s.id == id else { return }
      s.inFlight = false; self.deliver(s)
    }
    Function("flush") { (id: Int, epoch: Int) in
      self.lock.lock(); defer { self.lock.unlock() }
      guard let s = self.current, s.id == id, epoch > s.epoch else { return }
      s.epoch = epoch; s.outputSamples = 0
      s.player.stop(); s.player.play()
    }
    Function("play") { (id: Int, encoded: String, epoch: Int) in
      try self.play(id, encoded, epoch)
    }
    OnCreate { self.observe() }
    OnDestroy {
      if let id = self.current?.id { self.stop(id) }
      self.observers.forEach { NotificationCenter.default.removeObserver($0) }
      self.observers.removeAll()
    }
  }

  private func observe() {
    let center = NotificationCenter.default
    for (name, type) in [
      (AVAudioSession.routeChangeNotification, "route-change"),
      (AVAudioSession.interruptionNotification, "interruption"),
      (AVAudioSession.mediaServicesWereResetNotification, "error"),
      (UIApplication.didEnterBackgroundNotification, "background")
    ] {
      observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
        guard let self else { return }
        if name == AVAudioSession.routeChangeNotification,
          let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
          reason == AVAudioSession.RouteChangeReason.categoryChange.rawValue { return }
        self.lock.lock(); let s = self.current; self.lock.unlock()
        if let s { self.fail(s, type) }
      })
    }
  }

  private func start(_ id: Int) throws {
    lock.lock(); defer { lock.unlock() }
    guard current == nil else { throw audioError("Duplex audio already owned") }
    guard AVAudioSession.sharedInstance().recordPermission == .granted else { throw audioError("Microphone permission denied") }
    let s = Session(id)
    current = s
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetooth])
      try session.setPreferredIOBufferDuration(0.02)
      try session.setActive(true)
      let input = s.engine.inputNode
      try input.setVoiceProcessingEnabled(true)
      let format = input.outputFormat(forBus: 0)
      guard format.sampleRate >= 8000, format.sampleRate <= 192000,
        let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true),
        let converter = AVAudioConverter(from: format, to: target),
        let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false)
      else { throw audioError("Unsupported microphone format") }
      s.converter = converter
      s.engine.attach(s.player)
      s.engine.connect(s.player, to: s.engine.mainMixerNode, format: output)
      input.installTap(onBus: 0, bufferSize: AVAudioFrameCount(format.sampleRate / 50), format: format) { [weak self, weak s] buffer, _ in
        guard let self, let s else { return }
        self.capture(s, buffer, target)
      }
      s.tapInstalled = true
      s.engine.prepare(); try s.engine.start(); s.player.play()
    } catch {
      stop(id)
      throw error
    }
  }

  private func capture(_ s: Session, _ source: AVAudioPCMBuffer, _ target: AVAudioFormat) {
    lock.lock(); defer { lock.unlock() }
    guard current === s, !s.terminal, !s.muted else { return }
    guard source.frameLength <= 4096,
      let converter = s.converter,
      let buffer = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: 8192)
    else { fail(s, "error", "Microphone buffer exceeded its bound"); return }
    var supplied = false
    var error: NSError?
    let status = converter.convert(to: buffer, error: &error) { _, state in
      if supplied { state.pointee = .noDataNow; return nil }
      supplied = true; state.pointee = .haveData; return source
    }
    guard status != .error, error == nil, let samples = buffer.int16ChannelData?[0] else {
      fail(s, "error", error?.localizedDescription ?? "Microphone conversion failed"); return
    }
    for i in 0..<Int(buffer.frameLength) {
      let sample = UInt16(bitPattern: samples[i])
      s.frame.append(UInt8(truncatingIfNeeded: sample)); s.frame.append(UInt8(truncatingIfNeeded: sample >> 8))
      if s.frame.count == 640 {
        guard s.input.count < 4 else { fail(s, "error", "Microphone queue overflow"); return }
        s.input.append(s.frame); s.frame = Data(); deliver(s)
      }
    }
  }

  private func deliver(_ s: Session) {
    guard !s.inFlight, !s.input.isEmpty, !s.terminal else { return }
    s.inFlight = true
    sendEvent("voiceEvent", ["id": s.id, "type": "pcm", "pcm": s.input.removeFirst().base64EncodedString()])
  }

  private func play(_ id: Int, _ encoded: String, _ epoch: Int) throws {
    lock.lock(); defer { lock.unlock() }
    guard let s = current, s.id == id, s.epoch == epoch, !s.terminal else { return }
    guard encoded.utf8.count <= 42668, let bytes = Data(base64Encoded: encoded),
      !bytes.isEmpty, bytes.count <= 32000, bytes.count % 2 == 0,
      // Live streams a reply faster than it plays, so the queue holds a whole spoken reply.
      s.outputSamples + bytes.count / 2 <= 24000 * 120,
      let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24000, channels: 1, interleaved: false),
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(bytes.count / 2)),
      let samples = buffer.floatChannelData?[0]
    else { throw audioError("Invalid PCM or bounded playback queue overflow") }
    buffer.frameLength = buffer.frameCapacity
    bytes.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
      for i in 0..<Int(buffer.frameLength) {
        let bits = UInt16(raw[2 * i]) | UInt16(raw[2 * i + 1]) << 8
        samples[i] = Float(Int16(bitPattern: bits)) / 32768
      }
    }
    s.outputSamples += Int(buffer.frameLength)
    s.player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self, weak s] _ in
      guard let self, let s else { return }
      self.lock.lock(); defer { self.lock.unlock() }
      guard self.current === s, s.epoch == epoch else { return }
      s.outputSamples -= Int(buffer.frameLength)
    }
  }

  private func fail(_ s: Session, _ type: String, _ message: String? = nil) {
    lock.lock(); defer { lock.unlock() }
    guard current === s, !s.terminal else { return }
    s.terminal = true
    // Engine teardown cannot run from its real-time tap callback.
    DispatchQueue.main.async { [weak self, weak s] in
      guard let self, let s else { return }
      self.stop(s.id)
      self.sendEvent("voiceEvent", ["id": s.id, "type": type, "message": message ?? "Voice stopped: \(type). Connect again explicitly."])
    }
  }

  private func stop(_ id: Int) {
    lock.lock()
    guard let s = current, s.id == id else { lock.unlock(); return }
    current = nil; s.terminal = true; s.input.removeAll(); s.frame.removeAll()
    lock.unlock()
    if s.tapInstalled { s.engine.inputNode.removeTap(onBus: 0) }
    s.player.stop(); s.engine.stop(); s.converter?.reset()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  private func audioError(_ message: String) -> NSError {
    NSError(domain: "T3VoiceAudio", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
  }
}
