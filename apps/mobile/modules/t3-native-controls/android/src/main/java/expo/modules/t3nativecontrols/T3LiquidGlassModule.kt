package expo.modules.t3nativecontrols

import android.content.Context
import android.graphics.Canvas
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.RenderEffect
import android.graphics.RenderNode
import android.graphics.RuntimeShader
import android.graphics.Shader
import android.os.Build
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import androidx.annotation.ChecksSdkIntAtLeast
import androidx.annotation.RequiresApi
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.views.ExpoView

@ChecksSdkIntAtLeast(api = Build.VERSION_CODES.TIRAMISU)
private val SUPPORTED = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU

class T3LiquidGlassModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("T3LiquidGlass")

    View(T3LiquidGlassTargetView::class) {
      Name("T3LiquidGlassTargetView")
    }

    View(T3LiquidGlassView::class) {
      Name("T3LiquidGlassView")
      Prop("fallbackColor") { view: T3LiquidGlassView, color: Int -> view.fallbackColor = color }
      Prop("blur") { view: T3LiquidGlassView, value: Float -> view.setOption(blur = value) }
      Prop("saturation") { view: T3LiquidGlassView, value: Float ->
        view.setOption(saturation = value)
      }
      Prop("refraction") { view: T3LiquidGlassView, value: Float ->
        view.setOption(refraction = value)
      }
      Prop("dispersion") { view: T3LiquidGlassView, value: Float ->
        view.setOption(dispersion = value)
      }
    }
  }
}

/** Records its React Native children once per frame so glass drawn after it can sample them. */
class T3LiquidGlassTargetView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext) {
  internal val node: RenderNode? = if (SUPPORTED) RenderNode("T3LiquidGlassTarget") else null

  // React Native measures and positions children; LinearLayout's passes would restack them.
  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    setMeasuredDimension(
      MeasureSpec.getSize(widthMeasureSpec),
      MeasureSpec.getSize(heightMeasureSpec),
    )
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) = Unit

  override fun dispatchDraw(canvas: Canvas) {
    val node = node
    if (node == null || !canvas.isHardwareAccelerated) {
      super.dispatchDraw(canvas)
      return
    }
    node.setPosition(0, 0, width, height)
    val recording = node.beginRecording()
    try {
      super.dispatchDraw(recording)
    } finally {
      node.endRecording()
    }
    canvas.drawRenderNode(node)
  }
}

/**
 * Port of the web liquid glass filter (apps/web/src/liquid-glass/filter.ts): a 12dp rim refracts
 * the backdrop toward the center, split per color channel, then blurs and saturates it.
 */
class T3LiquidGlassView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  var fallbackColor = 0
    set(value) {
      field = value
      invalidate()
    }

  private var blur = 1f
  private var saturation = 100f
  private var refraction = 100f
  private var dispersion = 100f
  private val node: RenderNode? = if (SUPPORTED) RenderNode("T3LiquidGlass") else null
  private var target: T3LiquidGlassTargetView? = null
  private var searched = false
  private var effectDirty = true
  private val targetLocation = IntArray(2)
  private val location = IntArray(2)
  private var offsetX = Int.MIN_VALUE
  private var offsetY = Int.MIN_VALUE
  private var drewFallback = false

  private val preDraw = ViewTreeObserver.OnPreDrawListener {
    if (!searched || target?.isAttachedToWindow == false) resolveTarget()
    val target = target
    if (target != null) {
      target.getLocationInWindow(targetLocation)
      getLocationInWindow(location)
      // Target content changes show through by reference; only a move or a first recording redraws.
      val moved =
        location[0] - targetLocation[0] != offsetX || location[1] - targetLocation[1] != offsetY
      val recorded = drewFallback && target.node?.hasDisplayList() == true
      if (moved || recorded) invalidate()
    }
    true
  }

  init {
    setWillNotDraw(false)
  }

  fun setOption(
    blur: Float = this.blur,
    saturation: Float = this.saturation,
    refraction: Float = this.refraction,
    dispersion: Float = this.dispersion,
  ) {
    this.blur = blur
    this.saturation = saturation
    this.refraction = refraction
    this.dispersion = dispersion
    effectDirty = true
    invalidate()
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    searched = false
    viewTreeObserver.addOnPreDrawListener(preDraw)
  }

  override fun onDetachedFromWindow() {
    viewTreeObserver.removeOnPreDrawListener(preDraw)
    target = null
    node?.discardDisplayList()
    super.onDetachedFromWindow()
  }

  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
    super.onLayout(changed, left, top, right, bottom)
    if (changed) {
      searched = false
      effectDirty = true
    }
  }

  override fun onDraw(canvas: Canvas) {
    val node = node
    val target = target
    val sampling = canvas.isHardwareAccelerated && width > 0 && height > 0
    val targetNode = target?.node?.takeIf { sampling && it.hasDisplayList() }
    drewFallback = node == null || target == null || targetNode == null
    if (node == null || target == null || targetNode == null) {
      canvas.drawColor(fallbackColor)
      return
    }
    target.getLocationInWindow(targetLocation)
    getLocationInWindow(location)
    offsetX = location[0] - targetLocation[0]
    offsetY = location[1] - targetLocation[1]
    if (effectDirty) {
      node.setRenderEffect(createEffect())
      effectDirty = false
    }
    node.setPosition(0, 0, width, height)
    val recording = node.beginRecording()
    try {
      recording.translate(-offsetX.toFloat(), -offsetY.toFloat())
      recording.drawRenderNode(targetNode)
    } finally {
      node.endRecording()
    }
    canvas.drawRenderNode(node)
  }

  private fun resolveTarget() {
    searched = true
    target = findTarget()
    invalidate()
  }

  // The nearest target painted before this view, within its own screen and never an ancestor:
  // an ancestor would record this view into the node it samples.
  private fun findTarget(): T3LiquidGlassTargetView? {
    var child: View = this
    var found: T3LiquidGlassTargetView? = null
    while (found == null) {
      val parent = child.parent as? ViewGroup
      if (parent == null || parent is T3LiquidGlassTargetView) break
      found = (parent.indexOfChild(child) - 1 downTo 0).firstNotNullOfOrNull {
        lastTargetIn(parent.getChildAt(it))
      }
      if (isScreenBoundary(parent)) break
      child = parent
    }
    return found
  }

  private fun lastTargetIn(view: View): T3LiquidGlassTargetView? = when {
    view is T3LiquidGlassTargetView -> view
    view !is ViewGroup || isScreenBoundary(view) || view.visibility != VISIBLE -> null
    else -> (view.childCount - 1 downTo 0).firstNotNullOfOrNull {
      lastTargetIn(view.getChildAt(it))
    }
  }

  // A covered screen still draws during transitions; sampling it would show the wrong page.
  private fun isScreenBoundary(view: View) =
    view.javaClass.name.startsWith("com.swmansion.rnscreens.")

  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  private fun createEffect(): RenderEffect? {
    val density = resources.displayMetrics.density
    var effect: RenderEffect? = null
    val shader = if (refraction > 0f) compileShader() else null
    if (shader != null) {
      shader.setFloatUniform("size", width.toFloat(), height.toFloat())
      shader.setFloatUniform("rim", RIM_WIDTH_DP * density)
      shader.setFloatUniform("sigma", RIM_SOFTEN_DP * density)
      // Matches the web filter's per-channel scales: -19, -20, and -21 at 100%.
      val strength = refraction / 100f * density
      val spread = dispersion / 100f
      shader.setFloatUniform(
        "scale",
        (-20f + spread) * strength,
        -20f * strength,
        (-20f - spread) * strength,
      )
      effect = RenderEffect.createRuntimeShaderEffect(shader, "content")
    }
    // CSS blur takes a standard deviation; RenderEffect takes a radius it converts back to sigma.
    val sigma = blur * density
    if (sigma > 0.5f) {
      val radius = (sigma - 0.5f) / 0.57735f
      val blurEffect = RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.CLAMP)
      effect = effect?.let { RenderEffect.createChainEffect(blurEffect, it) } ?: blurEffect
    }
    if (saturation != 100f) {
      val matrix = ColorMatrix().apply { setSaturation(saturation / 100f) }
      val saturate = RenderEffect.createColorFilterEffect(ColorMatrixColorFilter(matrix))
      effect = effect?.let { RenderEffect.createChainEffect(saturate, it) } ?: saturate
    }
    return effect
  }

  // AGSL compiles on the device; a driver that rejects it must not crash every launch while the
  // persisted setting stays on, so the glass keeps its blur and tint without refraction.
  @RequiresApi(Build.VERSION_CODES.TIRAMISU)
  private fun compileShader(): RuntimeShader? = try {
    RuntimeShader(LIQUID_GLASS_SHADER)
  } catch (error: IllegalArgumentException) {
    Log.e("T3LiquidGlass", "Liquid glass shader failed to compile", error)
    null
  }

  private companion object {
    const val RIM_WIDTH_DP = 12f
    const val RIM_SOFTEN_DP = 4f

    // The web map is neutral inside a Gaussian-softened inner rect and ramps x/y across the rim;
    // displacement is scale * (map - 0.5). A logistic curve stands in for the blurred box edges.
    const val LIQUID_GLASS_SHADER = """
      uniform shader content;
      uniform float2 size;
      uniform float rim;
      uniform float sigma;
      uniform float3 scale;

      float edge(float x, float s) {
        return 1.0 / (1.0 + exp(-1.702 * x / s));
      }

      float inside(float x, float lo, float hi, float s) {
        return edge(x - lo, s) - edge(x - hi, s);
      }

      half4 main(float2 p) {
        float inner = inside(p.x, rim, size.x - rim, sigma) * inside(p.y, rim, size.y - rim, sigma);
        float2 direction = (1.0 - inner) * (p / size - 0.5);
        half4 green = content.eval(p + scale.y * direction);
        half red = content.eval(p + scale.x * direction).r;
        half blue = content.eval(p + scale.z * direction).b;
        return half4(red, green.g, blue, green.a);
      }
    """
  }
}
