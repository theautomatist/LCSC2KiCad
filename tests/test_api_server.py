import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from easyeda2kicad.api.server import create_app
from easyeda2kicad.service import ConversionRequest, ConversionResult, ConversionStage


def _dummy_runner(
    request: ConversionRequest, progress_cb
) -> ConversionResult:  # pragma: no cover - exercised through API
    result = ConversionResult(symbol_path=str(Path(request.output_prefix).resolve()))
    if progress_cb:
        progress_cb(ConversionStage.FETCHING, 50, "Fetching")
        progress_cb(ConversionStage.COMPLETED, 100, "Done")
    result.messages.append("ok")
    return result


class TaskApiTest(unittest.TestCase):
    def test_enqueue_and_complete(self) -> None:
        app = create_app(conversion_runner=_dummy_runner)
        with TestClient(app) as client:
            response = client.post(
                "/tasks",
                json={
                    "lcsc_id": "C1234",
                    "output_path": "./tmp/testlib",
                    "symbol": True,
                },
            )
            self.assertEqual(response.status_code, 202)
            task_id = response.json()["id"]

            detail = None
            for _ in range(20):
                time.sleep(0.05)
                detail = client.get(f"/tasks/{task_id}")
                if detail.json()["status"] == "completed":
                    break

            self.assertIsNotNone(detail)
            self.assertEqual(detail.json()["status"], "completed")
            expected_path = str(Path("./tmp/testlib").resolve())
            self.assertEqual(detail.json()["result"]["symbol_path"], expected_path)

    def test_filesystem_helpers(self) -> None:
        app = create_app(conversion_runner=_dummy_runner)
        with TestClient(app) as client:
            roots = client.get("/fs/roots")
            self.assertEqual(roots.status_code, 200)
            data = roots.json()
            self.assertIsInstance(data, list)
            self.assertGreater(len(data), 0)

            first_root = data[0]["path"]
            listing = client.get("/fs/list", params={"path": first_root})
            self.assertEqual(listing.status_code, 200)
            listing_data = listing.json()
            self.assertEqual(listing_data["path"], str(Path(first_root).resolve()))

            check = client.post("/fs/check", json={"path": first_root})
            self.assertEqual(check.status_code, 200)
            check_data = check.json()
            self.assertTrue(check_data["resolved"])

    def test_overwrite_model_forwarded(self) -> None:
        captured = {}

        def runner(request: ConversionRequest, progress_cb) -> ConversionResult:
            captured["overwrite_model"] = request.overwrite_model
            if progress_cb:
                progress_cb(ConversionStage.FETCHING, 50, "Fetching")
                progress_cb(ConversionStage.COMPLETED, 100, "Done")
            result = ConversionResult(symbol_path=str(Path("./tmp/testlib").resolve()))
            result.messages.append("ok")
            return result

        app = create_app(conversion_runner=runner)
        with TestClient(app) as client:
            response = client.post(
                "/tasks",
                json={
                    "lcsc_id": "C5678",
                    "output_path": "./tmp/testlib",
                    "symbol": True,
                    "model": True,
                    "overwrite_model": True,
                },
            )
            self.assertEqual(response.status_code, 202)
            task_id = response.json()["id"]
            for _ in range(20):
                time.sleep(0.05)
                detail = client.get(f"/tasks/{task_id}")
                if detail.json()["status"] == "completed":
                    break
            self.assertTrue(captured.get("overwrite_model"))
