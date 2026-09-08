# Preserve JNI annotations and every generated/native entry point. Product
# builds must not rely on a blanket keep of the historical GeckoView API.
-keepattributes *Annotation*

-keepclasseswithmembernames,includedescriptorclasses class * {
    native <methods>;
}

-keep class org.mozilla.gecko.mozglue.JNIObject { *; }
-keep class * extends org.mozilla.gecko.mozglue.JNIObject { *; }

-keep @interface org.mozilla.gecko.annotation.JNITarget
-keep @org.mozilla.gecko.annotation.JNITarget class *
-keepclassmembers class * {
    @org.mozilla.gecko.annotation.JNITarget *;
}

-keep @interface org.mozilla.gecko.annotation.WrapForJNI
-keep @org.mozilla.gecko.annotation.WrapForJNI class *
-keepclassmembers,includedescriptorclasses class * {
    @org.mozilla.gecko.annotation.WrapForJNI *;
}
-keepclassmembers,includedescriptorclasses @org.mozilla.gecko.annotation.WrapForJNI class * {
    *;
}

-keep @interface org.mozilla.gecko.annotation.ReflectionTarget
-keep @org.mozilla.gecko.annotation.ReflectionTarget class *
-keepclassmembers class * {
    @org.mozilla.gecko.annotation.ReflectionTarget *;
}

-keep class org.mozilla.gecko.process.GeckoChildProcessServices { *; }
-keep class org.mozilla.gecko.process.GeckoChildProcessServices$* { *; }

-dontwarn java.beans.BeanInfo
-dontwarn java.beans.FeatureDescriptor
-dontwarn java.beans.IntrospectionException
-dontwarn java.beans.Introspector
-dontwarn java.beans.PropertyDescriptor
