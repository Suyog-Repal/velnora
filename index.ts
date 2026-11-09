import { registerRootComponent } from 'expo';
import { AppRegistry } from 'react-native';

import App from './App';
import { CAPTURE_TASK_NAME, runBackgroundCapture } from './src/services/backgroundCapture';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);

// Payments that arrive while Velnora is closed are processed here, with no UI.
AppRegistry.registerHeadlessTask(CAPTURE_TASK_NAME, () => runBackgroundCapture);
