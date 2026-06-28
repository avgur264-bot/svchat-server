package ru.svchat.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.Ringtone;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Нативный «звонок» для Android: системный рингтон по кругу + вибрация +
// полноэкранное уведомление категории «звонок». Работает, пока процесс жив
// (передний план или фон), в том числе при погашенном экране.
@CapacitorPlugin(name = "CallRing")
public class CallRingPlugin extends Plugin {

    private static final String CHANNEL_ID = "svchat_calls";
    private static final int NOTIF_ID = 7714;
    private static final long MAX_RING_MS = 45000; // авто-стоп, если JS не успел остановить

    private Ringtone ringtone;
    private Vibrator vibrator;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable autoStop;

    private void ensureChannel(NotificationManager nm) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = nm.getNotificationChannel(CHANNEL_ID);
            if (ch == null) {
                ch = new NotificationChannel(CHANNEL_ID, "Входящие звонки", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("Уведомления о входящих звонках SVchat");
                // Звук и вибрацию ведём вручную (Ringtone + Vibrator), чтобы можно было остановить.
                ch.setSound(null, null);
                ch.enableVibration(false);
                ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                nm.createNotificationChannel(ch);
            }
        }
    }

    @PluginMethod
    public void ring(PluginCall call) {
        final String name = call.getString("name", "Входящий звонок");
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    startRing(name);
                } catch (Exception e) {
                    // не валим приложение из-за звонка
                }
                call.resolve();
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                stopRing();
                call.resolve();
            }
        });
    }

    private void startRing(String name) {
        Context ctx = getContext();
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        ensureChannel(nm);

        // Полноэкранное уведомление, открывающее приложение
        Intent open = new Intent(ctx, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(ctx, 0, open, flags);

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            b = new Notification.Builder(ctx, CHANNEL_ID);
        } else {
            b = new Notification.Builder(ctx);
        }
        b.setContentTitle("📞 " + name)
         .setContentText("Входящий звонок")
         .setSmallIcon(ctx.getApplicationInfo().icon)
         .setAutoCancel(false)
         .setOngoing(true)
         .setContentIntent(pi)
         .setFullScreenIntent(pi, true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            b.setCategory(Notification.CATEGORY_CALL);
            b.setVisibility(Notification.VISIBILITY_PUBLIC);
        }
        nm.notify(NOTIF_ID, b.build());

        // Рингтон по кругу
        try {
            if (ringtone != null && ringtone.isPlaying()) ringtone.stop();
            Uri uri = RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_RINGTONE);
            if (uri == null) uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE);
            ringtone = RingtoneManager.getRingtone(ctx, uri);
            if (ringtone != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                    ringtone.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build());
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) ringtone.setLooping(true);
                ringtone.play();
            }
        } catch (Exception e) { /* нет рингтона — остаётся вибрация */ }

        // Вибрация по кругу
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                VibratorManager vm = (VibratorManager) ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                vibrator = vm.getDefaultVibrator();
            } else {
                vibrator = (Vibrator) ctx.getSystemService(Context.VIBRATOR_SERVICE);
            }
            long[] pattern = {0, 800, 600, 800, 600};
            if (vibrator != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
                } else {
                    vibrator.vibrate(pattern, 0);
                }
            }
        } catch (Exception e) { /* без вибрации */ }

        // Авто-стоп через MAX_RING_MS
        if (autoStop != null) handler.removeCallbacks(autoStop);
        autoStop = new Runnable() {
            @Override public void run() { stopRing(); }
        };
        handler.postDelayed(autoStop, MAX_RING_MS);
    }

    private void stopRing() {
        try { if (autoStop != null) handler.removeCallbacks(autoStop); } catch (Exception e) {}
        try { if (ringtone != null && ringtone.isPlaying()) ringtone.stop(); } catch (Exception e) {}
        ringtone = null;
        try { if (vibrator != null) vibrator.cancel(); } catch (Exception e) {}
        vibrator = null;
        try {
            NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            nm.cancel(NOTIF_ID);
        } catch (Exception e) {}
    }

    @Override
    protected void handleOnDestroy() {
        stopRing();
        super.handleOnDestroy();
    }
}
