"""scripts/glimmer/serverless_probe.py against fakes (D03 T04 §2): the mode follows only from what the trainer returned,
the token cap is held before any session opens, and the session is closed whatever happens."""
import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "glimmer" / "serverless_probe.py"
spec = importlib.util.spec_from_file_location("serverless_probe", SCRIPT)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class Renderer:
    """Each example renders to one text chunk of 10 tokens and, when it has an image, one image chunk of 100."""

    def build_supervised_example(self, messages, train_on_what=None):
        chunks = [SimpleNamespace(type="encoded_text", tokens=list(range(10)))]
        parts = [p for m in messages if isinstance(m["content"], list) for p in m["content"]]
        if any(p.get("type") == "image" for p in parts):
            chunks.append(SimpleNamespace(type="image", expected_tokens=100))
        return SimpleNamespace(chunks=chunks), [1.0]


def datum(model_input, weights):
    return ("datum", len(model_input.chunks))


class Client:
    def __init__(self, image_error=None, text_error=None):
        self.calls, self.image_error, self.text_error = [], image_error, text_error

    def forward_backward(self, datums, loss):
        self.calls.append((loss, datums))
        has_image = any(chunks == 2 for _, chunks in datums)
        error = self.image_error if has_image else self.text_error
        if error:
            raise RuntimeError(error)
        return SimpleNamespace(result=lambda: SimpleNamespace(metrics={"loss": 1.5}))


class Service:
    def __init__(self, client=None, fail_client=None):
        self.client, self.fail_client, self.closed = client or Client(), fail_client, False
        self.training_session_id = "ts-test"

    def create_lora_training_client(self, base_model, rank):
        if self.fail_client:
            raise RuntimeError(self.fail_client)
        assert base_model == probe.BASE_MODEL
        return self.client

    def close(self):
        self.closed = True


IMAGE_EXAMPLES = [probe.conversation([
    {"role": "user", "content": [{"type": "text", "text": "q"},
                                 {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]},
    {"role": "assistant", "content": "a"},
])] * 3
TEXT_EXAMPLES = [[{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]] * 3


def run(service, cap=probe.TOKEN_CAP):
    return probe.run(lambda: service, Renderer(), IMAGE_EXAMPLES, TEXT_EXAMPLES, "last", datum_type=datum, cap=cap)


class ServerlessProbe(unittest.TestCase):
    def test_image_parts_become_the_renderers_image_parts(self):
        user = IMAGE_EXAMPLES[0][0]["content"]
        self.assertEqual(user[1], {"type": "image", "image": "data:image/png;base64,AAAA"})
        self.assertEqual(user[0], {"type": "text", "text": "q"})

    def test_a_loss_on_the_image_step_means_image_mode(self):
        service = Service()
        result = run(service)
        self.assertEqual(result["mode"], "image")
        self.assertEqual([loss for loss, _ in service.client.calls], ["cross_entropy", "cross_entropy"])
        self.assertEqual((result["image_tokens"], result["text_tokens"], result["tokens"]), (330, 30, 360))
        self.assertTrue(service.closed)

    def test_an_image_refusal_with_a_working_control_means_text_only(self):
        result = run(Service(Client(image_error="ImageChunk inputs are not supported for this model")))
        self.assertEqual(result["mode"], "text-only")
        self.assertIn("not supported", result["image"]["error"])

    def test_any_other_failure_decides_nothing(self):
        for client in (Client(image_error="quota exceeded"),
                       Client(image_error="image inputs not supported", text_error="session expired")):
            self.assertIsNone(run(Service(client))["mode"])

    def test_the_cap_refuses_before_a_session_opens(self):
        opened = []
        result = probe.run(lambda: opened.append(1) or Service(), Renderer(), IMAGE_EXAMPLES, TEXT_EXAMPLES, "last",
                           datum_type=datum, cap=100)
        self.assertIn("over the 100-token cap", result["refused"])
        self.assertEqual(opened, [])

    def test_the_session_is_closed_when_the_client_cannot_be_made(self):
        service = Service(fail_client="no capacity")
        with self.assertRaises(RuntimeError):
            run(service)
        self.assertTrue(service.closed)


if __name__ == "__main__":
    unittest.main()
