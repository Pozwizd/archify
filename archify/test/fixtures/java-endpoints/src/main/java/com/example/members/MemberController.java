package com.example.members;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/members")
public class MemberController {
    private final MemberService service;

    public MemberController(MemberService service) {
        this.service = service;
    }

    @PostMapping
    public MemberResponse create(@RequestBody CreateMemberRequest request) {
        return service.create(request);
    }

    @GetMapping("/{id}")
    public MemberResponse findById(@PathVariable Long id) {
        return service.findById(id);
    }

    @PutMapping("/{id}")
    public MemberResponse update(@PathVariable Long id, @RequestBody UpdateMemberRequest request) {
        return service.update(id, request);
    }

    @DeleteMapping("/{id}")
    public void delete(@PathVariable Long id) {
        service.delete(id);
    }
}
