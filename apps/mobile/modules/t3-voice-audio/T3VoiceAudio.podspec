Pod::Spec.new do |s|
  s.name = 'T3VoiceAudio'
  s.version = '0.0.0'
  s.summary = 'Bounded foreground duplex PCM for T3 Code.'
  s.description = 'Native voice-processing capture and epoch-scoped streaming playback.'
  s.homepage = 'https://t3tools.com'
  s.license = { :type => 'UNLICENSED' }
  s.author = { 'T3 Tools' => 'hello@t3tools.com' }
  s.platforms = { :ios => '16.1' }
  s.source = { :path => '.' }
  s.source_files = 'ios/**/*.{h,m,mm,swift}'
  s.frameworks = 'AVFoundation', 'UIKit'
  s.swift_version = '5.9'
  s.dependency 'ExpoModulesCore'
end
