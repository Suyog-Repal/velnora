import { Image, View } from 'react-native';

/**
 * The Velnora chevron symbol (the app icon's foreground layer, transparent background, no tile).
 * The source PNG is a square with generous padding around the symbol, so it is shown 1:1 (never stretched) through a
 * window cropped tightly to the symbol. `size` is the on-screen width of the symbol in px.
 */
const WINDOW_LEFT = 0.27;   // crop window, as fractions of the square source image
const WINDOW_TOP = 0.26;
const WINDOW_WIDTH = 0.46;
const WINDOW_HEIGHT = 0.44;

export function VelnoraLogo({ size = 100, onLoad }: { size?: number; onLoad?: () => void }) {
  const image = size / WINDOW_WIDTH;
  return <View style={{ width: size, height: image * WINDOW_HEIGHT, overflow: 'hidden' }} accessible accessibilityRole="image" accessibilityLabel="Velnora logo">
    <Image source={require('../../assets/android-icon-foreground.png')}
      style={{ position: 'absolute', left: -image * WINDOW_LEFT, top: -image * WINDOW_TOP, width: image, height: image }}
      resizeMode="contain" fadeDuration={0} onLoad={onLoad} />
  </View>;
}
