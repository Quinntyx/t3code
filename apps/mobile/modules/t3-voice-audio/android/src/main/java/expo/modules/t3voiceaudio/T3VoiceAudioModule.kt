package expo.modules.t3voiceaudio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioRouting
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.os.Handler
import android.os.Looper
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.ArrayDeque
import kotlin.concurrent.thread
import kotlin.math.roundToInt

private const val INPUT_RATE = 16000
private const val OUTPUT_RATE = 24000
private const val FRAME_BYTES = 640
private const val MAX_QUEUED_FRAMES = 4
private const val MAX_PLAY_BYTES = 32000
private const val MAX_PLAY_BASE64 = 42668

// Live streams a reply faster than it plays, so the queue holds a whole spoken reply.
private const val MAX_OUTPUT_BYTES = OUTPUT_RATE * 2 * 120
private const val WRITE_CHUNK_BYTES = 1920
private const val PCM16 = AudioFormat.ENCODING_PCM_16BIT

private class Session(
  val id: Int,
  val manager: AudioManager,
  val priorMode: Int,
  val record: AudioRecord,
  val track: AudioTrack,
) {
  var focus: AudioManager.OnAudioFocusChangeListener? = null
  var echo: AcousticEchoCanceler? = null
  var epoch = 0
  var muted = false
  var inputGeneration = 0
  var inFlight = false
  val input = ArrayDeque<ByteArray>()
  val output = ArrayDeque<ByteArray>()
  var outputBytes = 0
  var offset = 0
  var routes: Set<Int> = emptySet()
  var callback: AudioDeviceCallback? = null
  var routing: AudioRouting.OnRoutingChangedListener? = null
  var inputRoute = 0
  var outputRoute = 0
}

/** Foreground duplex PCM for Voice: 16 kHz capture with echo cancellation and 24 kHz playback. */
class T3VoiceAudioModule : Module() {
  private val lock = Object()
  private var current: Session? = null

  override fun definition() = ModuleDefinition {
    Name("T3VoiceAudio")
    Events("voiceEvent")
    AsyncFunction("start") { id: Int -> start(id) }
    Function("stop") { id: Int -> stop(id) }
    Function("mute") { id: Int, muted: Boolean -> mute(id, muted) }
    Function("acknowledge") { id: Int -> acknowledge(id) }
    Function("flush") { id: Int, epoch: Int -> flush(id, epoch) }
    Function("play") { id: Int, encoded: String, epoch: Int -> play(id, encoded, epoch) }
    OnActivityEntersBackground { currentId()?.let { fail(it, "background") } }
    OnDestroy { currentId()?.let { stop(it) } }
  }

  private fun currentId() = synchronized(lock) { current?.id }

  private fun session(id: Int) = current?.takeIf { it.id == id }

  private fun mute(id: Int, muted: Boolean) {
    synchronized(lock) {
      val s = session(id) ?: return
      s.muted = muted
      s.inputGeneration++
      s.input.clear()
    }
  }

  private fun acknowledge(id: Int) {
    synchronized(lock) {
      val s = session(id) ?: return
      s.inFlight = false
      deliver(s)
    }
  }

  private fun flush(id: Int, epoch: Int) {
    synchronized(lock) {
      val s = session(id)?.takeIf { epoch > it.epoch } ?: return
      s.epoch = epoch
      s.output.clear()
      s.outputBytes = 0
      s.offset = 0
      s.track.pause()
      s.track.flush()
      s.track.play()
      lock.notifyAll()
    }
  }

  private fun play(id: Int, encoded: String, epoch: Int) {
    synchronized(lock) {
      val s = session(id)?.takeIf { it.epoch == epoch } ?: return
      require(encoded.length <= MAX_PLAY_BASE64) { "Playback frame is too large" }
      val bytes = Base64.decode(encoded, Base64.NO_WRAP)
      require(bytes.isNotEmpty() && bytes.size <= MAX_PLAY_BYTES && bytes.size % 2 == 0) {
        "Invalid playback PCM"
      }
      check(s.outputBytes + bytes.size <= MAX_OUTPUT_BYTES) { "Playback fell too far behind" }
      s.output.add(bytes)
      s.outputBytes += bytes.size
      lock.notifyAll()
    }
  }

  private fun start(id: Int) {
    synchronized(lock) {
      check(current == null) { "Duplex audio already owned" }
      val context = appContext.reactContext ?: error("React context unavailable")
      val manager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
      val priorMode = manager.mode
      val focus = AudioManager.OnAudioFocusChangeListener { change ->
        if (change != AudioManager.AUDIOFOCUS_GAIN) fail(id, "interruption")
      }
      var recorder: AudioRecord? = null
      var player: AudioTrack? = null
      var started = false
      try {
        val granted = manager.requestAudioFocus(
          focus,
          AudioManager.STREAM_VOICE_CALL,
          AudioManager.AUDIOFOCUS_GAIN_TRANSIENT,
        )
        check(granted == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) { "Audio focus denied" }
        manager.mode = AudioManager.MODE_IN_COMMUNICATION
        val rate = captureRate()
        recorder = openRecorder(rate)
        player = openPlayer()
        val s = Session(id, manager, priorMode, recorder, player)
        s.focus = focus
        if (AcousticEchoCanceler.isAvailable()) {
          s.echo = AcousticEchoCanceler.create(recorder.audioSessionId)?.also { it.enabled = true }
        }
        current = s
        watchRoutes(s)
        recorder.startRecording()
        player.play()
        s.inputRoute = recorder.routedDevice?.id ?: 0
        s.outputRoute = player.routedDevice?.id ?: 0
        thread(name = "voice-capture-$id", isDaemon = true) { capture(s, rate) }
        thread(name = "voice-playback-$id", isDaemon = true) { playback(s) }
        started = true
      } finally {
        if (!started) {
          current?.takeIf { it.id == id }?.let {
            unwatchRoutes(it)
            it.echo?.release()
            current = null
          }
          recorder?.let { runCatching { it.stop() } }
          recorder?.release()
          player?.release()
          manager.abandonAudioFocus(focus)
          manager.mode = priorMode
        }
      }
    }
  }

  private fun inputBufferSize(rate: Int) =
    AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, PCM16)

  private fun captureRate() =
    listOf(48000, 44100, INPUT_RATE).first { rate -> inputBufferSize(rate) in 1..65536 }

  private fun openRecorder(rate: Int): AudioRecord {
    val size = inputBufferSize(rate)
    val format = AudioFormat.Builder()
      .setSampleRate(rate)
      .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
      .setEncoding(PCM16)
      .build()
    val recorder = AudioRecord.Builder()
      .setAudioSource(MediaRecorder.AudioSource.VOICE_COMMUNICATION)
      .setAudioFormat(format)
      .setBufferSizeInBytes(maxOf(size, rate / 5))
      .build()
    if (recorder.state != AudioRecord.STATE_INITIALIZED) {
      recorder.release()
      error("Microphone initialization failed")
    }
    return recorder
  }

  private fun openPlayer(): AudioTrack {
    val size = AudioTrack.getMinBufferSize(OUTPUT_RATE, AudioFormat.CHANNEL_OUT_MONO, PCM16)
    check(size in 1..OUTPUT_RATE * 2) { "Unsupported playback buffer" }
    val attributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
      .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
      .build()
    val format = AudioFormat.Builder()
      .setSampleRate(OUTPUT_RATE)
      .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
      .setEncoding(PCM16)
      .build()
    val player = AudioTrack.Builder()
      .setAudioAttributes(attributes)
      .setAudioFormat(format)
      .setTransferMode(AudioTrack.MODE_STREAM)
      .setBufferSizeInBytes(maxOf(size, OUTPUT_RATE * 2 / 5))
      .build()
    if (player.state != AudioTrack.STATE_INITIALIZED) {
      player.release()
      error("Speaker initialization failed")
    }
    return player
  }

  // A device appearing, disappearing or rerouting mid-conversation ends Voice rather than
  // silently moving the microphone or speaker.
  private fun watchRoutes(s: Session) {
    val main = Handler(Looper.getMainLooper())
    s.routes = routeIds(s.manager)
    val callback = object : AudioDeviceCallback() {
      private fun changed() {
        val changed = synchronized(lock) { current === s && routeIds(s.manager) != s.routes }
        if (changed) fail(s.id, "route-change")
      }

      override fun onAudioDevicesAdded(devices: Array<out AudioDeviceInfo>) = changed()

      override fun onAudioDevicesRemoved(devices: Array<out AudioDeviceInfo>) = changed()
    }
    s.callback = callback
    s.manager.registerAudioDeviceCallback(callback, main)
    val routing = AudioRouting.OnRoutingChangedListener { route -> rerouted(s, route) }
    s.routing = routing
    s.record.addOnRoutingChangedListener(routing, main)
    s.track.addOnRoutingChangedListener(routing, main)
  }

  private fun rerouted(s: Session, route: AudioRouting) {
    val changed = synchronized(lock) {
      val next = route.routedDevice?.id ?: 0
      val old = if (route === s.record) s.inputRoute else s.outputRoute
      if (route === s.record) s.inputRoute = next else s.outputRoute = next
      current === s && old != 0 && next != old
    }
    if (changed) fail(s.id, "route-change")
  }

  private fun unwatchRoutes(s: Session) {
    s.callback?.let { s.manager.unregisterAudioDeviceCallback(it) }
    s.routing?.let {
      s.record.removeOnRoutingChangedListener(it)
      s.track.removeOnRoutingChangedListener(it)
    }
  }

  private fun routeIds(manager: AudioManager) =
    manager.getDevices(AudioManager.GET_DEVICES_ALL).map { it.id }.toSet()

  private fun capture(s: Session, rate: Int) {
    val samples = ShortArray(rate / 50)
    var resampler = Pcm16Resampler(rate)
    var generation = 0
    runCatching {
      while (synchronized(lock) { current === s }) {
        val captured = synchronized(lock) { s.inputGeneration }
        val count = s.record.read(samples, 0, samples.size, AudioRecord.READ_BLOCKING)
        check(count > 0) { "Microphone read failed" }
        synchronized(lock) {
          if (generation != s.inputGeneration) {
            resampler = Pcm16Resampler(rate)
            generation = s.inputGeneration
          }
          if (current === s && !s.muted && captured == generation) {
            resampler.push(samples, count) { frame -> queueInput(s, frame) }
          }
        }
      }
    }.onFailure { fail(s.id, "error", it.message) }
  }

  private fun queueInput(s: Session, frame: ByteArray) {
    check(s.input.size < MAX_QUEUED_FRAMES) { "Microphone queue overflow" }
    s.input.add(frame)
    deliver(s)
  }

  private fun deliver(s: Session) {
    if (s.inFlight || s.input.isEmpty()) return
    s.inFlight = true
    val pcm = Base64.encodeToString(s.input.removeFirst(), Base64.NO_WRAP)
    sendEvent("voiceEvent", mapOf("id" to s.id, "type" to "pcm", "pcm" to pcm))
  }

  private fun playback(s: Session) {
    runCatching {
      synchronized(lock) {
        while (current === s) {
          val bytes = s.output.peekFirst()
          if (bytes == null) {
            lock.wait()
          } else {
            writeOutput(s, bytes)
          }
        }
      }
    }.onFailure { fail(s.id, "error", it.message) }
  }

  private fun writeOutput(s: Session, bytes: ByteArray) {
    val size = minOf(WRITE_CHUNK_BYTES, bytes.size - s.offset)
    val count = s.track.write(bytes, s.offset, size, AudioTrack.WRITE_NON_BLOCKING)
    check(count >= 0) { "Speaker write failed" }
    s.offset += count
    if (s.offset == bytes.size) {
      s.output.removeFirst()
      s.outputBytes -= bytes.size
      s.offset = 0
    } else {
      lock.wait(10)
    }
  }

  private fun fail(id: Int, type: String, message: String? = null) {
    if (!stop(id)) return
    val reason = message ?: "Voice stopped: $type. Talk again to reconnect."
    sendEvent("voiceEvent", mapOf("id" to id, "type" to type, "message" to reason))
  }

  private fun stop(id: Int): Boolean {
    val s = synchronized(lock) {
      val s = session(id) ?: return false
      current = null
      s.input.clear()
      s.output.clear()
      lock.notifyAll()
      s
    }
    unwatchRoutes(s)
    runCatching { s.record.stop() }
    s.record.release()
    runCatching {
      s.track.pause()
      s.track.flush()
    }
    s.track.release()
    s.echo?.release()
    s.focus?.let { s.manager.abandonAudioFocus(it) }
    if (s.manager.mode == AudioManager.MODE_IN_COMMUNICATION) s.manager.mode = s.priorMode
    return true
  }
}

/** Linear resampling to 16 kHz PCM16, emitted in 20 ms frames. */
internal class Pcm16Resampler(private val rate: Int) {
  private var index = 0L
  private var next = 0.0
  private var previous = 0.0
  private val frame = ByteArray(FRAME_BYTES)
  private var used = 0

  init {
    require(rate in 8000..192000)
  }

  fun push(samples: ShortArray, count: Int, emit: (ByteArray) -> Unit) {
    require(count in 0..samples.size && count <= 4096)
    for (i in 0 until count) {
      val value = samples[i].toDouble()
      while (next <= index) {
        val fraction = (next - (index - 1)).coerceIn(0.0, 1.0)
        val interpolated = previous + (value - previous) * fraction
        val sample = interpolated.roundToInt().coerceIn(-32768, 32767)
        frame[used++] = sample.toByte()
        frame[used++] = (sample shr 8).toByte()
        if (used == frame.size) {
          emit(frame.copyOf())
          used = 0
        }
        next += rate / INPUT_RATE.toDouble()
      }
      previous = value
      index++
    }
  }
}
