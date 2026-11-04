package com.fieldreports

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here, for example:
          // add(MyReactNativePackage())
        },
      // Normally BuildConfig.DEBUG. The extra flag lets a debug build skip the
      // dev server and boot from the JS packaged in the APK -- see the
      // USE_DEV_SERVER buildConfigField and `npm run android:bundled`.
      useDevSupport = BuildConfig.DEBUG && BuildConfig.USE_DEV_SERVER,
    )
  }

  override fun onCreate() {
    super.onCreate()
    loadReactNative(this)
  }
}
