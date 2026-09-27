// GODCP Unity bridge — optional helper for Unity MCP servers that do not
// expose a screenshot tool. Copy this file into Assets/Editor/ of your Unity
// project (alongside your Unity MCP server package).
//
// GODCP calls semantic op "render.screenshot"; if your MCP server maps that
// op to a custom tool, forward the destination path to GODCPScreenshot.Capture.

#if UNITY_EDITOR
using System;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace GODCP.Unity
{
    public static class GODCPScreenshot
    {
        /// <summary>
        /// Renders the active camera (or Scene view) to a PNG at destAbsPath.
        /// Returns the absolute path written.
        /// </summary>
        public static string Capture(string destAbsPath, int width = 1280, int height = 720)
        {
            if (string.IsNullOrEmpty(destAbsPath))
                throw new ArgumentException("destAbsPath must be non-empty", nameof(destAbsPath));

            var dir = Path.GetDirectoryName(destAbsPath);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

            var cam = Camera.main;
            RenderTexture rt = null;
            Texture2D tex = null;
            try
            {
                rt = new RenderTexture(width, height, 24);
                tex = new Texture2D(width, height, TextureFormat.RGB24, false);

                if (cam != null)
                {
                    var prev = cam.targetTexture;
                    cam.targetTexture = rt;
                    cam.Render();
                    cam.targetTexture = prev;
                }
                else
                {
                    // No main camera: fall back to the Scene view camera.
                    var sceneView = SceneView.lastActiveSceneView;
                    if (sceneView == null || sceneView.camera == null)
                        throw new InvalidOperationException("No Camera.main and no Scene view available to capture.");
                    sceneView.camera.targetTexture = rt;
                    sceneView.camera.Render();
                    sceneView.camera.targetTexture = null;
                }

                RenderTexture.active = rt;
                tex.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                tex.Apply();
            }
            finally
            {
                RenderTexture.active = null;
                if (rt != null) UnityEngine.Object.DestroyImmediate(rt);
            }

            File.WriteAllBytes(destAbsPath, tex.EncodeToPNG());
            UnityEngine.Object.DestroyImmediate(tex);
            Debug.Log($"[GODCP] Screenshot written: {destAbsPath}");
            return destAbsPath;
        }

        // MenuItem for manual testing inside the editor.
        [MenuItem("GODCP/Capture Screenshot")]
        private static void CaptureMenu()
        {
            var path = Path.Combine(Path.GetTempPath(), $"GODCP-{DateTime.Now:yyyyMMdd-HHmmss}.png");
            Capture(path);
        }
    }
}
#endif
