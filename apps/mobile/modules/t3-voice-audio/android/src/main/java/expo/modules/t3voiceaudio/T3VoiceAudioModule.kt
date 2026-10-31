package expo.modules.t3voiceaudio

import android.content.Context
import android.media.*
import android.media.audiofx.AcousticEchoCanceler
import android.os.Handler
import android.os.Looper
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.ArrayDeque
import kotlin.concurrent.thread
import kotlin.math.roundToInt

class T3VoiceAudioModule : Module() {
  private val lock = Object()
  private var current: Session? = null
  private data class Session(
    val id: Int,
    val manager: AudioManager,
    val record: AudioRecord,
    val track: AudioTrack,
    val focus: AudioManager.OnAudioFocusChangeListener,
    val priorMode: Int,
    val echo: AcousticEchoCanceler?,
    var epoch: Int = 0,
    var muted: Boolean = false,
    var inputGeneration: Int = 0,
    var inFlight: Boolean = false,
    val input: ArrayDeque<ByteArray> = ArrayDeque(),
    val output: ArrayDeque<ByteArray> = ArrayDeque(),
    var outputBytes: Int = 0,
    var offset: Int = 0,
    var routes: Set<Int> = emptySet(),
    var callback: AudioDeviceCallback? = null,
    var routing: AudioRouting.OnRoutingChangedListener? = null,
    var inputRoute: Int = 0,
    var outputRoute: Int = 0,
  )

  override fun definition() = ModuleDefinition {
    Name("T3VoiceAudio")
    Events("voiceEvent")
    AsyncFunction("start") { id: Int -> start(id) }
    Function("stop") { id: Int -> stop(id) }
    Function("mute") { id: Int, muted: Boolean -> synchronized(lock) {
      current?.takeIf { it.id == id }?.let { it.muted = muted; it.inputGeneration++; it.input.clear() }
    } }
    Function("acknowledge") { id: Int -> synchronized(lock) {
      current?.takeIf { it.id == id }?.let { it.inFlight = false; deliver(it) }
    } }
    Function("flush") { id: Int, epoch: Int -> synchronized(lock) {
      current?.takeIf { it.id == id && epoch > it.epoch }?.let {
        it.epoch = epoch; it.output.clear(); it.outputBytes = 0; it.offset = 0
        it.track.pause(); it.track.flush(); it.track.play()
        lock.notifyAll()
      }
    } }
    Function("play") { id: Int, encoded: String, epoch: Int -> synchronized(lock) {
      val s = current?.takeIf { it.id == id && it.epoch == epoch } ?: return@synchronized
      require(encoded.length <= 42668) { "Playback frame is too large" }
      val bytes = Base64.decode(encoded, Base64.NO_WRAP)
      require(bytes.isNotEmpty() && bytes.size <= 32000 && bytes.size % 2 == 0) { "Invalid playback PCM" }
      check(s.output.size < 4 && s.outputBytes + bytes.size <= 48000) { "Playback queue overflow" }
      s.output.add(bytes); s.outputBytes += bytes.size; lock.notifyAll()
    } }
    OnActivityEntersBackground { synchronized(lock) { current?.id }?.let { fail(it, "background") } }
    OnDestroy { synchronized(lock) { current?.id }?.let { stop(it) } }
  }

  private fun start(id: Int) {
    synchronized(lock) {
      check(current == null) { "Duplex audio already owned" }
      val context = appContext.reactContext ?: error("React context unavailable")
      val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val priorMode = manager.mode
      val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
      val focus = AudioManager.OnAudioFocusChangeListener { change ->
        if (change != AudioManager.AUDIOFOCUS_GAIN) fail(id, "interruption")
      }
      var recorder: AudioRecord? = null
      var player: AudioTrack? = null
      var echo: AcousticEchoCanceler? = null
      try {
        check(manager.requestAudioFocus(focus, AudioManager.STREAM_VOICE_CALL, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { "Audio focus denied" }
        manager.mode = AudioManager.MODE_IN_COMMUNICATION
        val rate = listOf(48000, 44100, 16000).first { rate ->
          AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT) in 1..65536
        }
        val size = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        recorder = AudioRecord.Builder().setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
          .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_IN_MONO)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build()).setBufferSizeInBytes(maxOf(size, rate / 5)).build()
        check(recorder.state == AudioRecord.STATE_INITIALIZED) { "Microphone initialization failed" }
        val outputSize = AudioTrack.getMinBufferSize(24000, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        check(outputSize in 1..48000) { "Unsupported playback buffer" }
        player = AudioTrack.Builder().setAudioAttributes(attributes)
          .setAudioFormat(AudioFormat.Builder().setSampleRate(24000).setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
          .setTransferMode(AudioTrack.MODE_STREAM).setBufferSizeInBytes(maxOf(outputSize, 9600)).build()
        check(player.state == AudioTrack.STATE_INITIALIZED) { "Speaker initialization failed" }
        if (AcousticEchoCanceler.isAvailable()) echo = AcousticEchoCanceler.create(recorder.audioSessionId)?.also { it.enabled = true }
        val s = Session(id, manager, recorder, player, focus, priorMode, echo)
        s.routes = routeIds(manager)
        s.callback = object : AudioDeviceCallback() {
          private fun changed() {
            val changed = synchronized(lock) { current === s && routeIds(manager) != s.routes }
            if (changed) fail(id, "route-change")
          }
          override fun onAudioDevicesAdded(devices: Array<out AudioDeviceInfo>) = changed()
          override fun onAudioDevicesRemoved(devices: Array<out AudioDeviceInfo>) = changed()
        }
        current = s
        s.callback?.let { manager.registerAudioDeviceCallback(it, Handler(Looper.getMainLooper())) }
        recorder.startRecording(); player.play()
        s.inputRoute = recorder.routedDevice?.id ?: 0
        s.outputRoute = player.routedDevice?.id ?: 0
        s.routing = AudioRouting.OnRoutingChangedListener { route ->
          val changed = synchronized(lock) {
            val next = route.routedDevice?.id ?: 0
            val old = if (route === s.record) s.inputRoute else s.outputRoute
            if (route === s.record) s.inputRoute = next else s.outputRoute = next
            current === s && old != 0 && next != old
          }
          if (changed) fail(id, "route-change")
        }
        s.routing?.let {
          recorder.addOnRoutingChangedListener(it, Handler(Looper.getMainLooper()))
          player.addOnRoutingChangedListener(it, Handler(Looper.getMainLooper()))
        }
        thread(name = "deus-capture-$id", isDaemon = true) { capture(s, rate) }
        thread(name = "deus-playback-$id", isDaemon = true) { playback(s) }
      } catch (error: Throwable) {
        current?.takeIf { it.id == id }?.let { s ->
          s.callback?.let { manager.unregisterAudioDeviceCallback(it) }
          s.routing?.let { s.record.removeOnRoutingChangedListener(it); s.track.removeOnRoutingChangedListener(it) }
          current = null
        }
        recorder?.let { runCatching { it.stop() }; it.release() }
        player?.release(); echo?.release()
        manager.abandonAudioFocus(focus); manager.mode = priorMode
        throw error
      }
    }
  }

  private fun routeIds(manager: AudioManager) = manager.getDevices(AudioManager.GET_DEVICES_ALL).map { it.id }.toSet()

  private fun capture(s: Session, rate: Int) {
    val samples = ShortArray(rate / 50)
    var resampler = Pcm16Resampler(rate)
    var generation = 0
    try {
      while (true) {
        val captured = synchronized(lock) { if (current !== s) return; s.inputGeneration }
        val count = s.record.read(samples, 0, samples.size, AudioRecord.READ_BLOCKING)
        check(count > 0) { "Microphone read failed" }
        synchronized(lock) {
          if (generation != s.inputGeneration) { resampler = Pcm16Resampler(rate); generation = s.inputGeneration }
          if (current === s && !s.muted && captured == generation) resampler.push(samples, count) { frame ->
            check(s.input.size < 4) { "Microphone queue overflow" }
            s.input.add(frame); deliver(s)
          }
        }
      }
    } catch (error: Throwable) { fail(s.id, "error", error.message) }
  }

  private fun deliver(s: Session) {
    if (s.inFlight || s.input.isEmpty()) return
    s.inFlight = true
    sendEvent("voiceEvent", mapOf("id" to s.id, "type" to "pcm", "pcm" to Base64.encodeToString(s.input.removeFirst(), Base64.NO_WRAP)))
  }

  private fun playback(s: Session) {
    try {
      synchronized(lock) {
        while (current === s) {
          val bytes = s.output.peekFirst()
          if (bytes == null) { lock.wait(); continue }
          val count = s.track.write(bytes, s.offset, minOf(1920, bytes.size - s.offset), AudioTrack.WRITE_NON_BLOCKING)
          check(count >= 0) { "Speaker write failed" }
          s.offset += count
          if (s.offset == bytes.size) { s.output.removeFirst(); s.outputBytes -= bytes.size; s.offset = 0 }
          else lock.wait(10)
        }
      }
    } catch (error: Throwable) { fail(s.id, "error", error.message) }
  }

  private fun fail(id: Int, type: String, message: String? = null) {
    if (!stop(id)) return
    sendEvent("voiceEvent", mapOf("id" to id, "type" to type, "message" to (message ?: "Voice stopped: $type. Connect again explicitly.")))
  }

  private fun stop(id: Int): Boolean {
    val s = synchronized(lock) {
      val s = current?.takeIf { it.id == id } ?: return false
      current = null; s.input.clear(); s.output.clear(); lock.notifyAll(); s
    }
    s.callback?.let { s.manager.unregisterAudioDeviceCallback(it) }
    s.routing?.let { s.record.removeOnRoutingChangedListener(it); s.track.removeOnRoutingChangedListener(it) }
    runCatching { s.record.stop() }; s.record.release()
    runCatching { s.track.pause(); s.track.flush() }; s.track.release(); s.echo?.release()
    s.manager.abandonAudioFocus(s.focus)
    if (s.manager.mode == AudioManager.MODE_IN_COMMUNICATION) s.manager.mode = s.priorMode
    return true
  }
}

internal class Pcm16Resampler(private val rate: Int) {
  private var index = 0L
  private var next = 0.0
  private var previous = 0.0
  private val frame = ByteArray(640)
  private var used = 0
  init { require(rate in 8000..192000) }
  fun push(samples: ShortArray, count: Int, emit: (ByteArray) -> Unit) {
    require(count in 0..samples.size && count <= 4096)
    for (i in 0 until count) {
      val value = samples[i].toDouble()
      while (next <= index) {
        val fraction = (next - (index - 1)).coerceIn(0.0, 1.0)
        val sample = (previous + (value - previous) * fraction).roundToInt().coerceIn(-32768, 32767)
        frame[used++] = sample.toByte(); frame[used++] = (sample shr 8).toByte()
        if (used == frame.size) { emit(frame.copyOf()); used = 0 }
        next += rate / 16000.0
      }
      previous = value; index++
    }
  }
}
